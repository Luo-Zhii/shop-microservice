"""python -m aiops [serve|detect-once]"""

import json
import logging
import sys


def main(argv=None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    cmd = argv[0] if argv else "serve"
    from .logging_setup import setup_logging

    setup_logging()
    if cmd == "serve":
        import uvicorn

        from .api import create_app
        from .config import load_settings

        s = load_settings()
        uvicorn.run(create_app(s), host="0.0.0.0", port=s.port, log_config=None, access_log=False)
    elif cmd == "detect-once":
        from .api import build
        from .config import load_settings

        s = load_settings()
        engine, _ = build(s)
        snap = engine.run_once()
        print(json.dumps(snap.to_dict() if snap else {}, ensure_ascii=False, indent=2, default=str))
    else:
        logging.error("lệnh không hỗ trợ: %s (serve | detect-once)", cmd)
        sys.exit(2)


if __name__ == "__main__":
    main()
