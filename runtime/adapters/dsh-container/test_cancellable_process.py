"""真实慢启动子进程必须收到全部输入，且轮询继续排空输出。"""

import hashlib
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scenario_analysis import run_cancellable_process


class CancellableProcessInputTest(unittest.TestCase):
    def test_large_input_survives_polling_during_slow_start(self):
        payload = "完整评测输入\n" * 32768
        polls = []
        program = (
            "import hashlib,sys,time;time.sleep(.5);"
            "sys.stdout.write('x'*131072);sys.stdout.flush();"
            "print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())"
        )
        result = run_cancellable_process(
            [sys.executable, "-c", program], input_text=payload, timeout=5,
            on_poll=lambda: polls.append(True),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "x" * 131072 + hashlib.sha256(payload.encode()).hexdigest() + "\n")
        self.assertGreaterEqual(len(polls), 3)

    def test_empty_input_reaches_eof_with_and_without_polling(self):
        for payload in (None, ""):
            for callback in (None, lambda: None):
                with self.subTest(payload=payload, polling=callback is not None):
                    result = run_cancellable_process(
                        [sys.executable, "-c", "import sys;print(repr(sys.stdin.read()))"],
                        input_text=payload, timeout=5, on_poll=callback,
                    )
                    self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "''\n", ""))


if __name__ == "__main__":
    unittest.main()
