"""Purpose: test helpers that expose a chosen module set to the command parser through the generated-loader path, with an
OmegaCode client for the modules that require one (code_workspace's service:omegacode)."""
import contextlib
import os
import pathlib
import tempfile


def omegacode_client_tree(root):
    """An omegacode package with a client module, as an OmegaCode release's src holds it; returns root for OMEGACODE_SRC."""
    package = pathlib.Path(root) / "omegacode"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("")
    (package / "client.py").write_text("class NativeClient:\n    pass\n")
    return str(root)


@contextlib.contextmanager
def enabled_module_loader(parser_module, *module_names, omegacode_client=False):
    """Temporarily expose a module set through the generated-loader path. With omegacode_client, the mind has an OmegaCode
    client (OMEGACODE_SRC) for both reloads' module selection, so a module requiring service:omegacode is parsed too."""
    old_loader = os.environ.get("OMEGACLAW_MODULE_LOADER")
    old_client = os.environ.get("OMEGACODE_SRC")
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
        if omegacode_client:
            os.environ["OMEGACODE_SRC"] = omegacode_client_tree(pathlib.Path(tmpdir) / "omegacode-src")
        parser_module.reload_signature_commands()
        try:
            yield
        finally:
            for name, old in (("OMEGACLAW_MODULE_LOADER", old_loader), ("OMEGACODE_SRC", old_client)):
                if old is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = old
            parser_module.reload_signature_commands()
