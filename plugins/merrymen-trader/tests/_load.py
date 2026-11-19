"""Load a script from a skill folder (the folder names have hyphens)."""

import importlib.util
import os

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.join(PLUGIN, "skills")  # the skill folders (upstream kept them at the repo root)
FIX = os.path.join(PLUGIN, "tests", "fixtures")


def load(folder, name):
    path = os.path.join(ROOT, folder, name + ".py")
    spec = importlib.util.spec_from_file_location("trader_" + name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
