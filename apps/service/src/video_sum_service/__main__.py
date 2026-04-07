import sys

from video_sum_core.transcribe_subprocess import main as transcribe_subprocess_main
from video_sum_service.main import run


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--transcribe-subprocess":
        sys.argv = [sys.argv[0], *sys.argv[2:]]
        raise SystemExit(transcribe_subprocess_main())
    run()
