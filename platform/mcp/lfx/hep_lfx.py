"""LFX 的仓库固定子流程、并发批次和现有平台工具适配。"""
import asyncio
import contextvars
import hashlib
import json
import types

import httpx
from lfx.custom import Component
from lfx.graph import Graph
from lfx.io import DataInput, IntInput, NestedDictInput, Output, StrInput
from lfx.schema import Data

current_run = contextvars.ContextVar("hep_run")
current_path = contextvars.ContextVar("hep_path", default="root")
modules = {}


def payload(value):
    return value.data if isinstance(value, Data) else value


def business(name="inspection"):
    source = current_run.get()["bundle"]["modules"][name]
    digest = hashlib.sha256(source.encode()).hexdigest()
    if digest not in modules:
        module = types.ModuleType("hep_business_" + digest)
        exec(compile(source, name + ".py", "exec"), module.__dict__)
        modules[digest] = module
    return modules[digest]


async def callback(action, **values):
    run = current_run.get()
    response = await run["client"].post(run["callback"], json={"action": action, **values},
                                        headers={"authorization": "Bearer " + run["token"]})
    response.raise_for_status()
    result = response.json()
    if result.get("error"):
        raise RuntimeError(result["error"])
    return result.get("value")


async def invoke(connection, operation, arguments):
    return await callback("invoke", connection=connection, operation=operation, arguments=arguments)


async def progress(node, **values):
    await callback("progress", node_id=current_path.get() + "/" + node, **values)


def result_data(outputs):
    for run in reversed(outputs):
        for output in reversed(run.outputs):
            for artifact in output.artifacts.values():
                if isinstance(artifact, dict) and "raw" in artifact:
                    return artifact["raw"]
    raise ValueError("LFX 流程没有 Data 输出")


async def run_graph(flow, input_value, path):
    token = current_path.set(path)
    run = current_run.get()
    run.setdefault("child_tasks", {})
    # 输入随 ContextVar 隔离，批次之间不共享可变输入。
    child = {**run, "input": input_value}
    run_token = current_run.set(child)
    try:
        graph = Graph.from_payload(flow, flow_id=hashlib.sha256(json.dumps(flow, sort_keys=True).encode()).hexdigest())
        outputs = [node["id"] for node in flow["data"]["nodes"] if node["data"]["node"].get("is_output")]
        return result_data(await graph.arun(inputs=[{}], outputs=outputs or None, fallback_to_env_vars=False))
    finally:
        current_run.reset(run_token)
        current_path.reset(token)


class HepComponent(Component):
    async def build_results(self):
        await progress(self._id, status="running", title=self.display_name)
        try:
            result = await super().build_results()
            await progress(self._id, status="completed")
            return result
        except Exception as error:
            await progress(self._id, status="failed", error=str(error))
            raise


class HepInput(HepComponent):
    display_name = "运行输入"
    inputs = []
    outputs = [Output(name="result", display_name="输入", method="build")]

    def build(self) -> Data:
        return Data(data=current_run.get()["input"])


class HepBatch(HepComponent):
    display_name = "有界并发批次"
    inputs = [DataInput(name="value", display_name="输入", required=True),
              NestedDictInput(name="body", display_name="原生流程体", required=True),
              StrInput(name="items_key", display_name="列表字段", value="items"),
              IntInput(name="concurrency", display_name="并发数", value=8)]
    outputs = [Output(name="result", display_name="结果", method="build")]

    async def build(self) -> Data:
        value = payload(self.value)
        items = value[self.items_key]
        if not isinstance(items, list) or not 1 <= self.concurrency <= 8:
            raise ValueError("批次要求列表输入及 1–8 的并发数")
        body = self.body
        results = [None] * len(items)
        cursor = 0

        async def worker():
            nonlocal cursor
            while cursor < len(items):
                index = cursor
                cursor += 1
                results[index] = await run_graph(body, {**value, "item": items[index], "index": index},
                                                 f"{current_path.get()}/{self._id}[{index}]")
                await progress(self._id, status="running", completed=sum(item is not None for item in results), total=len(items))

        async with asyncio.TaskGroup() as group:
            for _ in range(min(self.concurrency, len(items))):
                group.create_task(worker())
        return Data(data={**value, "items": results})


class HepChild(HepComponent):
    display_name = "固定版本子编排"
    inputs = [DataInput(name="value", display_name="输入", required=True),
              StrInput(name="composition_id", display_name="编排 ID", required=True),
              StrInput(name="version_id", display_name="固定版本", required=True)]
    outputs = [Output(name="result", display_name="结果", method="build")]

    async def build(self) -> Data:
        key = self.composition_id + ":" + self.version_id
        bundle = current_run.get()["bundle"]["children"].get(key)
        if bundle is None:
            raise ValueError("固定子编排未冻结：" + key)
        run = current_run.get()
        cache = run.setdefault("child_tasks", {})
        cache_key = key + ":" + json.dumps(payload(self.value), sort_keys=True)
        if cache_key in cache:
            return Data(data=await cache[cache_key])
        token = current_run.set({**run, "bundle": bundle})
        try:
            task = asyncio.create_task(run_graph(bundle["flow"], payload(self.value), current_path.get() + "/" + self._id))
            cache[cache_key] = task
            return Data(data=await task)
        finally:
            current_run.reset(token)
