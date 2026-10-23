"""真实进程信号覆盖评测取消；外部实例边界使用隔离目录，不操作业务容器。"""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest


ADAPTER = Path(__file__).resolve().parent
PROBE = r'''
import importlib.util,json,signal,sys,time,types
from importlib.machinery import SourceFileLoader
from pathlib import Path
spec=importlib.util.spec_from_loader("evaluation",SourceFileLoader("evaluation",sys.argv[1]))
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
base=Path(sys.argv[2]); mode=sys.argv[3]
signal.signal(signal.SIGTERM,m.request_cancellation)
experiment=base/"experiment"; run_id="run-11111111-1111-4111-8111-111111111111"; run=experiment/"runs"/run_id
cases=[{"case_id":"U-BASIC-001","inputs":["查询基础状态"],"expected_behavior":"展示基础状态"}]
contract={"source_id":"experiment:EXP-basic-001","agent_id":"basic","experiment_id":"EXP-basic-001","experiment_root":str(experiment),"image":{"build_fingerprint":"fixture"}}
def initialize(*args):
    run.mkdir(parents=True)
    (run/"inputs.lock.json").write_text(json.dumps({"evaluation_cases":cases}))
    (run/"run.yaml").write_text("status: running\n")
    if mode=="initialize":
        (base/"ready").write_text("initializing")
        time.sleep(.3)
    return run_id
def start(*args):
    (base/"instance-started").write_text("yes")
    return {"image_build_fingerprint":"fixture","image_tag":"fixture","image_id":"fixture","image_ref":"fixture","platform":"fixture"}
def driver(*args):
    program="import os,time,sys,subprocess;from pathlib import Path;child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);Path("+repr(str(base/"descendant.pid"))+").write_text(str(child.pid));Path("+repr(str(base/"driver.pid"))+").write_text(str(os.getpid()));time.sleep(60)"
    (base/"ready").write_text("driver")
    return m.run_process([sys.executable,"-c",program],timeout=70)
def stop(*args):
    (base/"cleanup-started").write_text("yes")
    time.sleep(.1)
    (base/"stopped").write_text("yes")
    return mode!="stop-failed"
def record(run_id,case_id,result): (run/"recorded.json").write_text(json.dumps(result))
def finalize(run_id,status): (run/"run.yaml").write_text("status: "+status+"\n")
g=m.execute.__globals__
g.update(REPO=base,resolve=lambda *a,**kw:contract,load_evaluation=lambda p:{},select_case_ids=lambda *a:["U-BASIC-001"],execution_for=lambda *a:cases,dry_run_payload=lambda *a,**kw:{"missing_env_names":[]},validate_before_run=lambda *a:{"repository":{"valid":True}},initialize_run=initialize,authentication_url=lambda *a:"http://127.0.0.1:1/",start_instance=start,run_driver=driver,stop_instance=stop,record_trial=record,finalize_run=finalize,validate_after_run=lambda *a:None)
raise SystemExit(m.execute(types.SimpleNamespace(source="experiment:EXP-basic-001",case=[],mode="fast",executor="api",review="none",compare_to=None,dry_run=False,model=None,timeout_seconds=30)))
'''


def alive(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().split()
        return fields[2] != "Z"
    except FileNotFoundError:
        return False


class EvaluationCancellationTest(unittest.TestCase):
    def probe(self, mode):
        temporary = tempfile.TemporaryDirectory(prefix="dsh-eval-cancel-test-")
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        script = base / "probe.py"
        script.write_text(PROBE)
        process = subprocess.Popen([sys.executable, str(script), str(ADAPTER / "dsh-eval"), str(base), mode],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        deadline = time.monotonic() + 5
        while not (base / "ready").exists():
            if process.poll() is not None:
                self.fail(process.communicate()[1])
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.01)
        if mode != "initialize":
            while not (base / "driver.pid").exists():
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.01)
        process.send_signal(signal.SIGTERM)
        if mode != "initialize":
            while not (base / "cleanup-started").exists():
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.01)
            process.send_signal(signal.SIGTERM)
        stdout, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 2, stderr)
        return base, json.loads(stdout)

    def test_sigterm_stops_driver_then_seals_cancelled_run(self):
        base, result = self.probe("driver")
        self.assertTrue((base / "stopped").exists())
        self.assertFalse(alive(int((base / "driver.pid").read_text())))
        self.assertFalse(alive(int((base / "descendant.pid").read_text())))
        self.assertEqual((base / "experiment/runs/run-11111111-1111-4111-8111-111111111111/run.yaml").read_text(), "status: cancelled\n")
        self.assertTrue(result["cancelled"])
        self.assertTrue(result["instance_stopped"])

    def test_cancel_during_run_initialization_preserves_id_and_never_starts_instance(self):
        base, result = self.probe("initialize")
        self.assertFalse((base / "instance-started").exists())
        self.assertEqual(result["run_id"], "run-11111111-1111-4111-8111-111111111111")
        self.assertTrue(result["cancelled"])
        self.assertEqual((base / "experiment/runs/run-11111111-1111-4111-8111-111111111111/run.yaml").read_text(), "status: cancelled\n")

    def test_unconfirmed_instance_stop_is_failed_not_successful_cancel(self):
        base, result = self.probe("stop-failed")
        self.assertFalse(result["instance_stopped"])
        self.assertEqual((base / "experiment/runs/run-11111111-1111-4111-8111-111111111111/run.yaml").read_text(), "status: failed\n")


if __name__ == "__main__":
    unittest.main()
