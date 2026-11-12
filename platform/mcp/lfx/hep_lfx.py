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


async def component(name, input_value, node_id):
    source = current_run.get()["bundle"].get("typescript")
    if not source:
        raise ValueError("当前原生流程未冻结 TypeScript 组件")
    return await callback("component", name=name, input=input_value,
                          node_id=current_path.get() + "/" + node_id,
                          module_digest=hashlib.sha256(source.encode()).hexdigest())


import re as _re
_SENSITIVE = _re.compile(r'(?i)(authorization|bearer|token|password|passwd|api[_-]?key|secret)\s*[:=]?\s*[^\s,;]+')
def error_summary(error, depth=0):
    """有界、脱敏的失败摘要；保留内层业务原因，不展开参数、headers 或源码。"""
    if depth > 3:
        return '……'
    if isinstance(error, BaseExceptionGroup):
        children = [error_summary(child, depth + 1) for child in error.exceptions[:3]]
        return 'ExceptionGroup: ' + ' | '.join(child for child in children if child)
    text = _SENSITIVE.sub(r'\1=[已脱敏]', ' '.join(str(error).split()))
    return f'{type(error).__name__}: {text[:300]}' if text else type(error).__name__

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
            await progress(self._id, status="failed", error=error_summary(error))
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
                item = items[index]
                try:
                    results[index] = await run_graph(body, {**value, "item": item, "index": index},
                                                     f"{current_path.get()}/{self._id}[{index}]")
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    # 单项失败按真实粒度保留，不能吞成成功，也不能丢其他已读项。
                    base = dict(item) if isinstance(item, dict) else {"item": item}
                    results[index] = {**base, "status": "failed", "complete": False,
                                      "error": str(error) or type(error).__name__}
                await progress(self._id, status="running", completed=sum(item is not None for item in results), total=len(items))

        try:
            async with asyncio.TaskGroup() as group:
                for _ in range(min(self.concurrency, len(items))):
                    group.create_task(worker())
        except BaseExceptionGroup as error:
            # 进度/基础设施异常仍按 TaskGroup 取消并等待全部 worker；只保留有界原因。
            raise RuntimeError('批次执行失败：' + error_summary(error)) from error
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
        cache_key = current_path.get() + "/" + self._id + ":" + key + ":" + json.dumps(payload(self.value), sort_keys=True)
        if cache_key in cache:
            return Data(data=await cache[cache_key])
        token = current_run.set({**run, "bundle": bundle})
        try:
            task = asyncio.create_task(run_graph(bundle["flow"], payload(self.value), current_path.get() + "/" + self._id))
            cache[cache_key] = task
            return Data(data=await task)
        finally:
            current_run.reset(token)
