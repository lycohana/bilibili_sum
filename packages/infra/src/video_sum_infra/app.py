from dataclasses import dataclass


@dataclass(slots=True)
class AppInfo:
    name: str
    version: str

    @classmethod
    def load(cls) -> "AppInfo":
        return cls(name="BriefVid", version="0.1.0")
