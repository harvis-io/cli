from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("harvis")
except PackageNotFoundError:
    __version__ = "0.0.0"
