from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import venv


ROOT = Path(__file__).resolve().parents[2]
BUILD_ROOT = ROOT / "build" / "pyinstaller"
BUILD_VENV_DIR = BUILD_ROOT / "build-venv"
BIN_DIR = BUILD_ROOT / "bin"
PROJECT_FFMPEG_DIR = ROOT / "tools" / "ffmpeg" / "win-x64"
SPEC_PATH = ROOT / "packaging" / "pyinstaller" / "briefvid.spec"


def run(command: list[str], cwd: Path | None = None) -> None:
    subprocess.run(command, cwd=cwd or ROOT, check=True)


def remove_tree(target: Path, retries: int = 6, delay: float = 0.5) -> None:
    if not target.exists():
        return
    last_error: OSError | None = None
    for _ in range(retries):
        try:
            shutil.rmtree(target)
            return
        except OSError as error:
            last_error = error
            time.sleep(delay)
    if last_error is not None:
        raise last_error


def ensure_python_version() -> None:
    if sys.version_info[:2] != (3, 12):
        raise SystemExit("PyInstaller onedir build must run with Python 3.12.")


def build_python() -> Path:
    candidates = [
        BUILD_VENV_DIR / "Scripts" / "python.exe",
        BUILD_VENV_DIR / "python.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise FileNotFoundError("Build virtualenv python.exe was not created.")


def create_build_venv() -> None:
    if BUILD_VENV_DIR.exists():
        remove_tree(BUILD_VENV_DIR)
    builder = venv.EnvBuilder(with_pip=True, clear=True)
    builder.create(BUILD_VENV_DIR)


def copy_ffmpeg_binaries() -> None:
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    source_dir = resolve_ffmpeg_source_dir()
    if source_dir is None:
        raise SystemExit(
            "Bundled ffmpeg not found. "
            f"Expected repo-managed binaries in {PROJECT_FFMPEG_DIR} "
            "or a usable VIDEO_SUM_FFMPEG_DIR / system ffmpeg installation."
        )

    for name in ("ffmpeg.exe", "ffprobe.exe"):
        source = source_dir / name
        if source.exists():
            shutil.copy2(source, BIN_DIR / name)


def resolve_ffmpeg_source_dir() -> Path | None:
    if ffmpeg_dir_is_usable(PROJECT_FFMPEG_DIR):
        return PROJECT_FFMPEG_DIR

    env_dir = os.environ.get("VIDEO_SUM_FFMPEG_DIR")
    if env_dir:
        candidate = Path(env_dir).resolve()
        if ffmpeg_dir_is_usable(candidate):
            return candidate
        print(f"warning: VIDEO_SUM_FFMPEG_DIR is not usable: {candidate}")

    raw_candidates: list[Path] = []
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path:
        raw_candidates.append(Path(ffmpeg_path).resolve())

    where_exe = shutil.which("where.exe")
    if where_exe:
        try:
            output = subprocess.run(
                [where_exe, "ffmpeg"],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            ).stdout
            for line in output.splitlines():
                line = line.strip()
                if line:
                    raw_candidates.append(Path(line).resolve())
        except subprocess.CalledProcessError:
            pass

    checked_dirs: list[Path] = []
    for ffmpeg_executable in raw_candidates:
        for candidate_dir in ffmpeg_dir_candidates(ffmpeg_executable):
            if candidate_dir in checked_dirs:
                continue
            checked_dirs.append(candidate_dir)
            if ffmpeg_dir_is_usable(candidate_dir):
                return candidate_dir
    return None


def ffmpeg_dir_candidates(ffmpeg_executable: Path) -> list[Path]:
    candidates = [ffmpeg_executable.parent]
    path_text = str(ffmpeg_executable).lower()
    if "chocolatey\\bin\\ffmpeg.exe" in path_text:
        candidates.insert(0, ffmpeg_executable.parent.parent / "lib" / "ffmpeg" / "tools" / "ffmpeg" / "bin")
    return [candidate.resolve() for candidate in candidates]


def ffmpeg_dir_is_usable(directory: Path) -> bool:
    ffmpeg_executable = directory / "ffmpeg.exe"
    ffprobe_executable = directory / "ffprobe.exe"
    if not ffmpeg_executable.exists() or not ffprobe_executable.exists():
        return False
    return executable_runs(ffmpeg_executable) and executable_runs(ffprobe_executable)


def executable_runs(executable: Path) -> bool:
    try:
        subprocess.run(
            [str(executable), "-version"],
            cwd=executable.parent,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return True


def install_build_dependencies() -> None:
    python_exe = build_python()
    run([str(python_exe), "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"])
    run([str(python_exe), "-m", "pip", "install", "--upgrade", "pyinstaller"])
    run(
        [
            str(python_exe),
            "-m",
            "pip",
            "install",
            str(ROOT / "packages" / "infra"),
            str(ROOT / "packages" / "core"),
            str(ROOT / "apps" / "service"),
        ]
    )


def main() -> int:
    ensure_python_version()
    BUILD_ROOT.mkdir(parents=True, exist_ok=True)
    create_build_venv()
    install_build_dependencies()
    copy_ffmpeg_binaries()
    run([str(build_python()), "-m", "PyInstaller", "--noconfirm", "--clean", str(SPEC_PATH)])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
