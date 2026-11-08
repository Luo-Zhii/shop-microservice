import uvicorn

from .app import create_app
from .config import Settings


def main() -> None:
    s = Settings()
    uvicorn.run(create_app(s), host="0.0.0.0", port=s.port, log_config=None, access_log=False)


if __name__ == "__main__":
    main()
