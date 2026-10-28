import contextlib
import os
import pathlib
import tempfile


@contextlib.contextmanager
def enabled_module_loader(parser_module, *module_names):
    """Temporarily expose a module set through the generated-loader path."""
    old_loader = os.environ.get("OMEGACLAW_MODULE_LOADER")
    with tempfile.TemporaryDirectory() as tmpdir:
        loader = pathlib.Path(tmpdir) / "modules-loader.metta"
        loader.write_text(
            "\n".join(
                f"!(import! &self (library OmegaClaw-Core ./modules/{name}/entry.metta))"
                for name in module_names
            )
            + "\n",
            encoding="utf-8",
        )
        os.environ["OMEGACLAW_MODULE_LOADER"] = str(loader)
        parser_module.reload_signature_commands()
        try:
            yield
        finally:
            if old_loader is None:
                os.environ.pop("OMEGACLAW_MODULE_LOADER", None)
            else:
                os.environ["OMEGACLAW_MODULE_LOADER"] = old_loader
            parser_module.reload_signature_commands()
