"""Shim: cho phép `cd aiops && python -m aiops.<module>` (CI dùng working-directory: aiops).

Khi chạy từ trong thư mục aiops/, `import aiops` tìm thấy gói này; nó trỏ __path__ về thư mục cha (gói thật),
nên `aiops.eval.synthetic`, `aiops.ci_assistant`… là cùng một mã như khi chạy từ gốc repo.
"""

import os as _os

__path__ = [_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))]
_real_init = _os.path.join(__path__[0], "__init__.py")
with open(_real_init, encoding="utf-8") as _f:
    exec(compile(_f.read(), _real_init, "exec"))
