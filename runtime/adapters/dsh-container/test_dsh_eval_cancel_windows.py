"""以真实信号检查进程登记和 Run 所有权交接；不操作真实实例或 Run。"""

import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest


ADAPTER = Path(__file__).resolve().parent
PROBE = runpy.run_path(str(ADAPTER / "test_dsh_eval_cancel.py"))["PROBE"]
EXECUTE = 'raise SystemExit(m.execute(types.SimpleNamespace(source="experiment:EXP-basic-001",case=[],mode="fast",executor="api",review="none",compare_to=None,dry_run=False,model=None,timeout_seconds=30,instance_name="existing" if mode=="existing" else None)))'

SPAWN_PROBE = r'''
import json,os,signal,sys,time
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import scenario_analysis as m
pid=None
def interrupt(*_args): raise KeyboardInterrupt
signal.signal(signal.SIGTERM,interrupt)
original=m.subprocess.Popen
def spawn_then_cancel(*args,**kwargs):
    global pid
    process=original(*args,**kwargs)
    pid=process.pid
    os.kill(os.getpid(),signal.SIGTERM)
    return process
def alive():
    try: return Path(f"/proc/{pid}/stat").read_text().split()[2]!="Z"
    except FileNotFoundError: return False
m.subprocess.Popen=spawn_then_cancel
try:
    interrupted=False
    try: m.run_cancellable_process([sys.executable,"-c","import time;time.sleep(30)"],timeout=35)
    except KeyboardInterrupt: interrupted=True
    time.sleep(.05)
    print(json.dumps({"interrupted":interrupted,"child_alive":alive(),"handler_restored":signal.getsignal(signal.SIGTERM) is interrupt}))
finally:
    if pid:
        try: os.killpg(pid,signal.SIGKILL)
        except ProcessLookupError: pass
        try: os.waitpid(pid,0)
        except ChildProcessError: pass
'''

CLEANUP_PROBE = r'''
import json,os,signal,subprocess,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import scenario_analysis as m
base=Path(sys.argv[2]); mode=sys.argv[3]; completed=False
def interrupt(*_args): raise KeyboardInterrupt
signal.signal(signal.SIGTERM,interrupt)
def stop():
    global completed
    os.kill(os.getpid(),signal.SIGTERM)
    completed=True
    if mode.endswith("failed"): raise RuntimeError("fixture-stop-failed")
    return ""
if mode.startswith("analysis"):
    m._locked_harness=lambda *args,**kwargs: []
    m._target_route=lambda *_: {"provider":"fixture","model":"fixture"}
    m._review_driver=lambda *_: {"results":[]}
    def external(command,*,stage,**kwargs):
        if stage=="instance-start": return json.dumps({"image_ref":"fixture"})
        if stage=="authentication": return "http://127.0.0.1:1/?token=fixture-only"
        if stage=="instance-stop": return stop()
        raise AssertionError(stage)
    m._run=external
    run_dir=base/"evolution/experiments/EXP-basic-001/runs/run-fixture"
    run_dir.mkdir(parents=True)
    invoke=lambda: m.review_full(run_dir,[],{"run_id":"run-fixture","source_id":"experiment:EXP-basic-001","evaluation_cases":[],"case_catalog":[]})
else:
    original=m.subprocess.Popen
    def external_spawn(command,**kwargs):
        assert command[:2]==["docker","run"]
        return original([sys.executable,"-c","pass"],**kwargs)
    def external_remove(command,**kwargs):
        assert command[:3]==["docker","rm","-f"]
        try: stop()
        except RuntimeError: return subprocess.CompletedProcess(command,1,"","fixture removal refused")
        return subprocess.CompletedProcess(command,0,"","")
    m.subprocess.Popen=external_spawn
    m.subprocess.run=external_remove
    invoke=lambda: m.run_cancellable_process(["docker","run","fixture"],timeout=5)
interrupted=False; cleanup_error=False
try: invoke()
except KeyboardInterrupt: interrupted=True
except m.ProcessCleanupError: cleanup_error=True
print(json.dumps({"cleanup_completed":completed,"interrupted":interrupted,"cleanup_error":cleanup_error,"handler_restored":signal.getsignal(signal.SIGTERM) is interrupt}))
'''


class EvaluationCancellationWindowTest(unittest.TestCase):
    def directory(self):
        temporary = tempfile.TemporaryDirectory(prefix="dsh-eval-cancel-window-")
        self.addCleanup(temporary.cleanup)
        return Path(temporary.name)

    def owned_run_probe(self, window):
        base = self.directory()
        # trace 只延长既有 Python 行边界，不替换 execute 的持久化与清理控制流。
        injection = r'''
import inspect,os
owner=getattr(m,"execute_owned_run",m.execute)
lines,first=inspect.getsourcelines(owner)
at=None
if mode=="handoff":
    initialized=next(index for index,text in enumerate(lines) if text.strip()=="stop_reason = None")
    at=next(index for index,text in enumerate(lines) if index>initialized and text.strip()=="with allow_cancellation():")
elif mode=="post-cleanup":
    g["run_driver"]=lambda *args: (_ for _ in ()).throw(m.EvaluationError("fixture-failure"))
    at=next(index for index,text in enumerate(lines) if text.strip()=="if fatal_reason:")
elif mode=="record":
    g["run_driver"]=lambda *args: {"rows":[{"case_id":"U-BASIC-001","execution_status":"completed","verdict":"passed","observation":"fixture result","evidence_ref":"evidence/U-BASIC-001/checks.json"}]}
    def record_and_cancel(*args):
        with (base/"record-count").open("a") as output: output.write("recorded\n")
        os.kill(os.getpid(),signal.SIGTERM)
    g["record_trial"]=record_and_cancel
elif mode=="cleanup-failed":
    g["run_driver"]=lambda *args: (_ for _ in ()).throw(m.ProcessCleanupError("driver-container-stop-unconfirmed"))
line=first+at if at is not None else None
def trace(frame,event,arg):
    if frame.f_code is owner.__code__ and event=="line" and frame.f_lineno==line:
        sys.settrace(None)
        os.kill(os.getpid(),signal.SIGTERM)
    return trace
if line is not None: sys.settrace(trace)
'''
        self.assertIn(EXECUTE, PROBE)
        script = base / "probe.py"
        script.write_text(PROBE.replace(EXECUTE, injection + "\n" + EXECUTE))
        completed = subprocess.run(
            [sys.executable, str(script), str(ADAPTER / "dsh-eval"), str(base), window],
            text=True, capture_output=True, timeout=10,
        )
        self.assertEqual(completed.returncode, 2, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertEqual(result["run_id"], "run-11111111-1111-4111-8111-111111111111")
        manifest = base / "experiment/runs" / result["run_id"] / "run.yaml"
        return base, result, manifest.read_text()

    def cleanup_probe(self, mode):
        base = self.directory()
        script = base / "cleanup.py"
        script.write_text(CLEANUP_PROBE)
        completed = subprocess.run(
            [sys.executable, str(script), str(ADAPTER), str(base), mode],
            text=True, capture_output=True, timeout=10,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertTrue(result["cleanup_completed"], "首次取消不能中断已经开始的清理")
        self.assertTrue(result["handler_restored"])
        return result

    def test_sigterm_after_real_spawn_before_process_assignment_reaps_child(self):
        base = self.directory()
        script = base / "spawn.py"
        script.write_text(SPAWN_PROBE)
        completed = subprocess.run(
            [sys.executable, str(script), str(ADAPTER), str(base)],
            text=True, capture_output=True, timeout=10,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertTrue(result["interrupted"], "取消信号不能在进程登记时被吞掉")
        self.assertFalse(result["child_alive"], "Popen 已创建而尚未赋值的子进程也必须被回收")
        self.assertTrue(result["handler_restored"])

    def test_sigterm_at_initialization_handoff_preserves_run_and_seals_cancelled(self):
        base, result, manifest = self.owned_run_probe("handoff")
        self.assertEqual(manifest, "status: cancelled\n")
        self.assertTrue(result["cancelled"])
        self.assertTrue(result["instance_stopped"])
        self.assertFalse((base / "instance-started").exists())

    def test_first_sigterm_after_cleanup_cannot_leave_failed_run_running(self):
        base, result, manifest = self.owned_run_probe("post-cleanup")
        self.assertIn(manifest, ["status: failed\n", "status: cancelled\n"])
        self.assertTrue((base / "stopped").exists())
        self.assertTrue(result["instance_stopped"])

    def test_cancel_after_record_append_does_not_record_same_case_again(self):
        base, result, manifest = self.owned_run_probe("record")
        self.assertEqual(manifest, "status: cancelled\n")
        self.assertTrue(result["cancelled"])
        self.assertEqual((base / "record-count").read_text().splitlines(), ["recorded"])

    def test_driver_cleanup_failure_remains_failed_when_target_stop_succeeds(self):
        base, result, manifest = self.owned_run_probe("cleanup-failed")
        self.assertEqual(manifest, "status: failed\n")
        self.assertTrue((base / "stopped").exists())
        self.assertFalse(result["instance_stopped"], "目标实例已停不能掩盖本次驱动仍未确认移除")

    def test_first_sigterm_during_analysis_down_waits_for_cleanup(self):
        result = self.cleanup_probe("analysis")
        self.assertTrue(result["interrupted"])
        self.assertFalse(result["cleanup_error"])

    def test_analysis_down_failure_takes_priority_over_pending_cancel(self):
        result = self.cleanup_probe("analysis-failed")
        self.assertTrue(result["cleanup_error"])
        self.assertFalse(result["interrupted"])

    def test_first_sigterm_during_driver_removal_waits_for_cleanup(self):
        result = self.cleanup_probe("driver")
        self.assertTrue(result["interrupted"])
        self.assertFalse(result["cleanup_error"])

    def test_driver_removal_failure_takes_priority_over_pending_cancel(self):
        result = self.cleanup_probe("driver-failed")
        self.assertTrue(result["cleanup_error"])
        self.assertFalse(result["interrupted"])


if __name__ == "__main__":
    unittest.main()
