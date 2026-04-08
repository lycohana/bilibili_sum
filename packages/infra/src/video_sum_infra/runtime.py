from __future__ import annotations

import ctypes
from contextlib import contextmanager
import json
import os
import shutil
import sys
from pathlib import Path


APP_SLUG = "briefvid"


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def bundled_root() -> Path:
    if is_frozen():
        meipass = getattr(sys, "_MEIPASS", "")
        if meipass:
            return Path(meipass).resolve()
        return Path(sys.executable).resolve().parent
    return repo_root()


def web_static_dir() -> Path:
    if is_frozen():
        return bundled_root() / "web" / "static"
    return repo_root() / "apps" / "web" / "static"


def bundled_bin_dir() -> Path:
    if is_frozen():
        return bundled_root() / "bin"
    return repo_root() / "bin"


def local_appdata_dir() -> Path:
    local_appdata = os.environ.get("LOCALAPPDATA")
    if local_appdata:
        return Path(local_appdata)
    return Path.home() / "AppData" / "Local"


def app_data_root() -> Path:
    return local_appdata_dir() / APP_SLUG


def default_data_dir() -> Path:
    return app_data_root() / "data"


def default_cache_dir() -> Path:
    return default_data_dir() / "cache"


def default_tasks_dir() -> Path:
    return default_data_dir() / "tasks"


def default_database_url() -> str:
    return f"sqlite:///{(default_data_dir() / 'video_sum.db').as_posix()}"


def managed_runtime_root() -> Path:
    return app_data_root() / "runtime"


def managed_runtime_dir(runtime_channel: str) -> Path:
    return managed_runtime_root() / runtime_channel


def log_dir() -> Path:
    return app_data_root() / "logs"


def service_log_path() -> Path:
    return log_dir() / "service.log"


def bundled_runtime_seed_dir() -> Path:
    return bundled_root() / "runtime" / "base"


def runtime_seed_available() -> bool:
    return bundled_runtime_seed_dir().exists()


def read_runtime_metadata(target_dir: Path) -> dict[str, object]:
    metadata_path = target_dir / "video_sum_runtime.json"
    if not metadata_path.exists():
        return {}
    try:
        payload = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def bundled_runtime_seed_metadata() -> dict[str, object]:
    return read_runtime_metadata(bundled_runtime_seed_dir())


def runtime_python_candidates(runtime_dir: Path) -> list[Path]:
    """返回 Python 解释器候选路径列表。
    
    优先查找根目录的 python.exe（可重定位的解释器），
    其次才是 Scripts 目录的 venv 启动器（可能硬编码了原始路径）。
    """
    return [
        runtime_dir / "python.exe",           # 优先：根目录的可重定位解释器
        runtime_dir / "Scripts" / "python.exe",  # 次选：venv 启动器（可能硬编码路径）
    ]


def runtime_scripts_dir(runtime_dir: Path) -> Path:
    scripts_dir = runtime_dir / "Scripts"
    if scripts_dir.exists():
        return scripts_dir
    return runtime_dir


def runtime_library_dirs(runtime_channel: str) -> list[Path]:
    runtime_dir = managed_runtime_dir(runtime_channel)
    candidates: list[Path] = []

    python_executable = runtime_python_executable(runtime_channel)
    if python_executable is not None:
        candidates.append(python_executable.parent)
    portable_dlls_dir = runtime_dir / "DLLs"
    if portable_dlls_dir.exists():
        candidates.append(portable_dlls_dir)
    candidates.append(runtime_scripts_dir(runtime_dir))

    torch_lib_dir = runtime_dir / "Lib" / "site-packages" / "torch" / "lib"
    if torch_lib_dir.exists():
        candidates.append(torch_lib_dir)

    nvidia_root = runtime_dir / "Lib" / "site-packages" / "nvidia"
    if nvidia_root.exists():
        for bin_dir in sorted(nvidia_root.rglob("bin")):
            if bin_dir.is_dir():
                candidates.append(bin_dir)

    cuda_path = os.environ.get("CUDA_PATH")
    if cuda_path:
        cuda_bin_dir = Path(cuda_path) / "bin"
        if cuda_bin_dir.exists():
            candidates.append(cuda_bin_dir)

    unique_dirs: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            resolved = candidate
        key = str(resolved).lower()
        if not candidate.exists() or key in seen:
            continue
        seen.add(key)
        unique_dirs.append(resolved)
    return unique_dirs


def runtime_worker_executable(runtime_channel: str) -> Path | None:
    runtime_dir = managed_runtime_dir(runtime_channel)
    scripts_dir = runtime_scripts_dir(runtime_dir)
    candidates = [
        scripts_dir / "video-sum-transcribe-worker.exe",
        scripts_dir / "video-sum-transcribe-worker",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def runtime_python_executable(runtime_channel: str) -> Path | None:
    """获取托管运行时 Python 解释器路径。
    
    优先查找根目录的 python.exe（可重定位的解释器），
    其次才是 Scripts 目录的 venv 启动器。
    
    注意：不再回退到 sys.executable，因为在生产环境中这可能导致
    使用开发环境的 Python 路径。
    """
    runtime_dir = managed_runtime_dir(runtime_channel)
    for candidate in runtime_python_candidates(runtime_dir):
        if candidate.exists():
            return candidate
    return None


def ffmpeg_location() -> Path | None:
    """返回 ffmpeg 可执行文件的路径（不是目录）。"""
    # 1. 环境变量指定的目录
    env_dir = os.environ.get("VIDEO_SUM_FFMPEG_DIR")
    if env_dir:
        candidate = Path(env_dir)
        if candidate.exists():
            ffmpeg_exe = candidate / "ffmpeg.exe"
            if ffmpeg_exe.exists():
                return ffmpeg_exe

    # 2. 打包后的 bin 目录
    bundled_dir = bundled_bin_dir()
    if bundled_dir.exists():
        ffmpeg_exe = bundled_dir / "ffmpeg.exe"
        if ffmpeg_exe.exists():
            return ffmpeg_exe

    # 3. 系统 PATH 中的 ffmpeg
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path:
        return Path(ffmpeg_path).resolve()

    return None


def prepend_runtime_path(runtime_channel: str) -> None:
    paths = [str(path) for path in runtime_library_dirs(runtime_channel)]
    ffmpeg_exe = ffmpeg_location()
    if ffmpeg_exe is not None:
        # 添加 ffmpeg 所在目录到 PATH
        paths.append(str(ffmpeg_exe.parent))

    current_path = os.environ.get("PATH", "")
    for value in reversed(paths):
        if value and value not in current_path:
            current_path = f"{value}{os.pathsep}{current_path}" if current_path else value
    os.environ["PATH"] = current_path


def bootstrap_managed_runtime(runtime_channel: str = "base") -> Path | None:
    runtime_dir = managed_runtime_dir(runtime_channel)
    if runtime_channel != "base" or not is_frozen() or not runtime_seed_available():
        if runtime_python_executable(runtime_channel) is not None:
            return runtime_dir
        return None

    seed_dir = bundled_runtime_seed_dir()
    seed_metadata = bundled_runtime_seed_metadata()
    runtime_metadata = read_runtime_metadata(runtime_dir)
    runtime_ready = runtime_python_executable(runtime_channel) is not None
    seed_version = str(seed_metadata.get("appVersion") or "")
    runtime_version = str(runtime_metadata.get("appVersion") or "")
    requires_refresh = (
        not runtime_ready
        or runtime_version != seed_version
        or runtime_metadata.get("runtimeLayout") != seed_metadata.get("runtimeLayout")
    )
    if not requires_refresh:
        return runtime_dir

    runtime_dir.parent.mkdir(parents=True, exist_ok=True)
    if runtime_dir.exists():
        shutil.rmtree(runtime_dir)
    shutil.copytree(seed_dir, runtime_dir, dirs_exist_ok=True)
    return runtime_dir


def runtime_metadata_path(runtime_channel: str) -> Path:
    return managed_runtime_dir(runtime_channel) / "video_sum_runtime.json"


def write_runtime_metadata(runtime_channel: str, payload: dict[str, object]) -> None:
    target = runtime_metadata_path(runtime_channel)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _get_windows_dll_directory() -> str | None:
    if os.name != "nt":
        return None
    kernel32 = ctypes.windll.kernel32
    kernel32.GetDllDirectoryW.restype = ctypes.c_uint32
    needed = kernel32.GetDllDirectoryW(0, None)
    if needed == 0:
        return None
    buffer = ctypes.create_unicode_buffer(needed)
    kernel32.GetDllDirectoryW(needed, buffer)
    return buffer.value


def _set_windows_dll_directory(path: str | None) -> None:
    if os.name != "nt":
        return
    kernel32 = ctypes.windll.kernel32
    kernel32.SetDllDirectoryW.argtypes = [ctypes.c_wchar_p]
    kernel32.SetDllDirectoryW.restype = ctypes.c_int
    if not kernel32.SetDllDirectoryW(path):
        raise OSError(ctypes.get_last_error(), "SetDllDirectoryW failed")


@contextmanager
def sanitized_subprocess_dll_search():
    if os.name != "nt" or not is_frozen():
        yield
        return

    previous = _get_windows_dll_directory()
    _set_windows_dll_directory(None)
    try:
        yield
    finally:
        _set_windows_dll_directory(previous)
