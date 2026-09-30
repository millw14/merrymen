"""Point-in-time perpetual-market research. This package has no execution authority."""

from .analysis import STRATEGY_VERSION, analyze
from .schema import InputError

__all__ = ["STRATEGY_VERSION", "InputError", "analyze"]
