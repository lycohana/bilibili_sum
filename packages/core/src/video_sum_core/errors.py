class VideoSumError(Exception):
    """Base application error for core domain logic."""


class UnsupportedInputError(VideoSumError):
    """Raised when an input type is not supported by the current pipeline."""
