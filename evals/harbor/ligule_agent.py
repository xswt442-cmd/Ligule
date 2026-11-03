"""Harbor v0.25.0 installed-agent adapter for a built Ligule npm tarball."""

from __future__ import annotations

import hashlib
import json
import re
import shlex
import tarfile
import tempfile
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent, NonZeroAgentExitCodeError
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


INSTALL_PREFIX = "/installed-agent"
PACKAGE_ROOT = f"{INSTALL_PREFIX}/node_modules/ligule"
TARBALL_TARGET = f"{INSTALL_PREFIX}/ligule.tgz"
NODE_RUNTIME_DIRECTORY = f"{INSTALL_PREFIX}/node-runtime"
NODE_RUNTIME_TARBALL_TARGET = f"{NODE_RUNTIME_DIRECTORY}/node-runtime.tar.gz"
NODE_RUNTIME_BIN = f"{NODE_RUNTIME_DIRECTORY}/bin"
APT_SOURCES_TARGET = f"{INSTALL_PREFIX}/apt-sources.list"
REMOTE_EXPORTER = f"{PACKAGE_ROOT}/export_session.mjs"
REMOTE_POLICY_MODE = f"{PACKAGE_ROOT}/policy-mode.mjs"
MAX_MODEL_CALLS = 64
MAX_TASK_TIMEOUT_MS = 86_400_000
MAX_REQUEST_TIMEOUT_MS = 3_600_000
MAX_SAFE_INTEGER = (1 << 53) - 1
ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
RESERVED_API_KEY_ENV = {
    "LIGULE_HOME", "PATH", "HOME", "TMPDIR", "TMP", "TEMP",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS",
}
NODE_VERSION = re.compile(r"^v?(\d+)\.")
NPM_VERSION = re.compile(r"^\d+\.\d+\.\d+(?:[-+].*)?$")
ANSI_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")
SHA256_TOKEN = re.compile(r"(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])")


def sha256_from_output(output: str) -> str:
    matches = SHA256_TOKEN.findall(output)
    return matches[-1] if matches else ""


def tsinghua_apt_setup_command() -> str:
    sources = shlex.quote(APT_SOURCES_TARGET)
    apt_options = (
        f"-o Dir::Etc::sourcelist={sources} "
        "-o Dir::Etc::sourceparts=- -o Acquire::Languages=none"
    )
    return (
        "set -eu; "
        f"apt_sources={sources}; "
        "trap 'rm -f \"$apt_sources\"' EXIT; "
        "apt_id=$(grep '^ID=' /etc/os-release | head -n 1 | cut -d= -f 2 | tr -d '\"'); "
        "apt_codename=$(grep '^VERSION_CODENAME=' /etc/os-release | head -n 1 | cut -d= -f 2 | tr -d '\"'); "
        "case \"$apt_codename\" in ''|*[!a-z0-9-]*) "
        "echo 'ligule_setup_apt_mirror_codename_invalid' >&2; exit 1 ;; esac; "
        "case \"$apt_id\" in "
        "debian) printf 'deb https://mirrors.tuna.tsinghua.edu.cn/debian %s main\\n"
        "deb https://mirrors.tuna.tsinghua.edu.cn/debian %s-updates main\\n"
        "deb https://mirrors.tuna.tsinghua.edu.cn/debian-security %s-security main\\n' "
        "\"$apt_codename\" \"$apt_codename\" \"$apt_codename\" > \"$apt_sources\" ;; "
        "ubuntu) printf 'deb https://mirrors.tuna.tsinghua.edu.cn/ubuntu %s main\\n"
        "deb https://mirrors.tuna.tsinghua.edu.cn/ubuntu %s-updates main\\n"
        "deb https://mirrors.tuna.tsinghua.edu.cn/ubuntu %s-security main\\n' "
        "\"$apt_codename\" \"$apt_codename\" \"$apt_codename\" > \"$apt_sources\" ;; "
        "*) echo 'ligule_setup_apt_mirror_os_unsupported' >&2; exit 1 ;; esac; "
        f"apt-get {apt_options} update && "
        "DEBIAN_FRONTEND=noninteractive apt-get "
        f"{apt_options} install -y --no-install-recommends build-essential python3"
    )


def release_manifest(path: str | Path) -> dict[str, str]:
    """Read the npm package identity without extracting the supplied tarball."""
    tarball = Path(path)
    if not tarball.is_absolute() or tarball.is_symlink() or not tarball.is_file():
        raise ValueError("ligule_tarball_must_be_an_absolute_regular_file")

    with tarfile.open(tarball, "r:gz") as archive:
        matches = [item for item in archive.getmembers() if item.name == "package/package.json"]
        if len(matches) != 1 or not matches[0].isfile() or matches[0].size > 1_000_000:
            raise ValueError("ligule_tarball_package_manifest_invalid")
        stream = archive.extractfile(matches[0])
        if stream is None:
            raise ValueError("ligule_tarball_package_manifest_unreadable")
        try:
            manifest = json.loads(stream.read().decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as error:
            raise ValueError("ligule_tarball_package_manifest_invalid") from error

    if not isinstance(manifest, dict) or manifest.get("name") != "ligule":
        raise ValueError("ligule_tarball_package_name_invalid")
    version = manifest.get("version")
    if not isinstance(version, str) or not version.strip():
        raise ValueError("ligule_tarball_package_version_invalid")
    digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
    return {"name": "ligule", "version": version, "sha256": digest}


def checked_node_runtime(path: str | Path | None, expected_sha256: str | None) -> tuple[Path | None, str | None]:
    if path is None and expected_sha256 is None:
        return None, None
    if path is None or expected_sha256 is None:
        raise ValueError("ligule_node_runtime_configuration_incomplete")

    archive = Path(path)
    if (not archive.is_absolute() or archive.is_symlink() or not archive.is_file()
            or not archive.name.endswith(".tar.gz") or archive.stat().st_size > 100_000_000):
        raise ValueError("ligule_node_runtime_tarball_invalid")
    if not SHA256_HEX.fullmatch(expected_sha256):
        raise ValueError("ligule_node_runtime_sha256_invalid")

    digest = hashlib.sha256()
    with archive.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != expected_sha256:
        raise ValueError("ligule_node_runtime_sha256_mismatch")
    return archive, expected_sha256


def checked_run_limits(model_calls: int, timeout_ms: int, request_timeout_ms: int) -> None:
    if not isinstance(model_calls, int) or isinstance(model_calls, bool) or not 1 <= model_calls <= MAX_MODEL_CALLS:
        raise ValueError("ligule_model_calls_out_of_range")
    if not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool) or not 1 <= timeout_ms <= MAX_TASK_TIMEOUT_MS:
        raise ValueError("ligule_task_timeout_out_of_range")
    if (not isinstance(request_timeout_ms, int) or isinstance(request_timeout_ms, bool)
            or not 1 <= request_timeout_ms <= min(timeout_ms, MAX_REQUEST_TIMEOUT_MS)):
        raise ValueError("ligule_request_timeout_out_of_range")


class LiguleAgent(BaseInstalledAgent):
    """Run the exact supplied tarball and export its canonical Session as ATIF."""

    capabilities = AgentCapabilities(atif=True)

    def __init__(
        self,
        logs_dir: Path,
        *,
        ligule_tarball: str,
        ligule_api: str,
        ligule_base_url: str,
        ligule_model: str | None = None,
        ligule_api_key_env: str = "LIGULE_API_KEY",
        ligule_model_calls: int = 5,
        ligule_timeout_ms: int = 3_600_000,
        ligule_request_timeout_ms: int = 120_000,
        ligule_node_runtime_tarball: str | None = None,
        ligule_node_runtime_sha256: str | None = None,
        ligule_install_build_tools: bool = False,
        ligule_setup_apt_mirror: str | None = None,
        ligule_setup_proxy_url: str | None = None,
        ligule_output_tokens: int | None = None,
        **kwargs: Any,
    ) -> None:
        self.tarball_path = Path(ligule_tarball)
        self.package = release_manifest(self.tarball_path)
        self.node_runtime_path, self.node_runtime_sha256 = checked_node_runtime(
            ligule_node_runtime_tarball, ligule_node_runtime_sha256
        )
        if not isinstance(ligule_install_build_tools, bool):
            raise ValueError("ligule_install_build_tools_invalid")
        self.ligule_install_build_tools = ligule_install_build_tools
        if ligule_setup_apt_mirror not in {None, "tsinghua"}:
            raise ValueError("ligule_setup_apt_mirror_invalid")
        self.ligule_setup_apt_mirror = ligule_setup_apt_mirror
        if ligule_setup_proxy_url is not None:
            try:
                proxy = urlsplit(ligule_setup_proxy_url)
                proxy.port
            except ValueError:
                raise ValueError("ligule_setup_proxy_url_invalid") from None
            if (proxy.scheme not in {"http", "https"} or not proxy.hostname
                    or proxy.username is not None or proxy.password is not None
                    or proxy.path not in {"", "/"} or proxy.query or proxy.fragment):
                raise ValueError("ligule_setup_proxy_url_invalid")
        self.ligule_setup_proxy_url = ligule_setup_proxy_url
        if (ligule_output_tokens is not None
                and (not isinstance(ligule_output_tokens, int)
                     or isinstance(ligule_output_tokens, bool)
                     or not 1 <= ligule_output_tokens <= MAX_SAFE_INTEGER)):
            raise ValueError("ligule_output_tokens_out_of_range")
        self.ligule_output_tokens = ligule_output_tokens
        self.node_bin_directory: str | None = None
        self.ligule_api = ligule_api
        self.ligule_base_url = ligule_base_url
        self.ligule_model = ligule_model
        self.ligule_api_key_env = ligule_api_key_env
        self.ligule_model_calls = ligule_model_calls
        self.ligule_timeout_ms = ligule_timeout_ms
        self.ligule_request_timeout_ms = ligule_request_timeout_ms
        self._last_trial: dict[str, str] | None = None
        checked_run_limits(ligule_model_calls, ligule_timeout_ms, ligule_request_timeout_ms)
        if ligule_api not in {"messages", "chat-completions"}:
            raise ValueError("ligule_api_unsupported")
        if urlsplit(ligule_base_url).scheme not in {"http", "https"} or not urlsplit(ligule_base_url).netloc:
            raise ValueError("ligule_base_url_invalid")
        if (not ENV_NAME.fullmatch(ligule_api_key_env) or ligule_api_key_env in RESERVED_API_KEY_ENV
                or ligule_api_key_env.startswith(("NODE_", "LD_", "DYLD_"))):
            raise ValueError("ligule_api_key_env_invalid")
        super().__init__(logs_dir, version=self.package["version"], **kwargs)
        self.ligule_model = ligule_model or self.model_name
        if not self.ligule_model:
            raise ValueError("ligule_model_required")
        if len(self.ligule_model) > 256:
            raise ValueError("ligule_model_invalid")

    @staticmethod
    def name() -> str:
        return "ligule"

    async def _prepare_install_prefix(self, environment: BaseEnvironment) -> None:
        owner = environment.default_user
        if owner is not None:
            quoted_owner = shlex.quote(str(owner))
            command = (
                "test -d /installed-agent && test ! -L /installed-agent "
                "&& test -z \"$(ls -A /installed-agent)\" "
                f"&& chown -- {quoted_owner} /installed-agent && chmod 0755 /installed-agent"
            )
            await self.exec_as_root(environment, command=command, timeout_sec=30)
        await self.exec_as_agent(
            environment,
            command=(
                "test -d /installed-agent && test ! -L /installed-agent "
                "&& test -w /installed-agent && test -x /installed-agent"
            ),
            timeout_sec=30,
        )

    def _with_node_path(self, command: str) -> str:
        if self.node_bin_directory is None:
            return command
        return (
            f"export PATH={shlex.quote(self.node_bin_directory)}:\"$PATH\"; "
            f"{command}"
        )

    async def _node_runtime_ready(self, environment: BaseEnvironment) -> bool:
        command = self._with_node_path("node --version && npm --version")
        runtime = await self.exec_as_agent(environment, command=f"{command} || true", timeout_sec=30)
        lines = ANSI_ESCAPE.sub("", runtime.stdout).splitlines()
        node_index = next(
            (index for index, line in enumerate(lines) if NODE_VERSION.match(line.strip())),
            None,
        )
        if node_index is None:
            return False
        node_match = NODE_VERSION.match(lines[node_index].strip())
        npm_available = any(NPM_VERSION.fullmatch(line.strip()) for line in lines[node_index + 1:])
        return node_match is not None and int(node_match.group(1)) >= 24 and npm_available

    async def _install_node_runtime(self, environment: BaseEnvironment) -> None:
        if self.node_runtime_path is None or self.node_runtime_sha256 is None:
            raise RuntimeError("ligule_requires_node_24_or_newer")
        await self.exec_as_agent(
            environment,
            command=f"mkdir -m 700 {shlex.quote(NODE_RUNTIME_DIRECTORY)}",
            timeout_sec=30,
        )
        await self._upload_agent_owned_file(
            environment, self.node_runtime_path, NODE_RUNTIME_TARBALL_TARGET
        )
        remote_hash = await self.exec_as_agent(
            environment,
            command=(
                f"test -f {shlex.quote(NODE_RUNTIME_TARBALL_TARGET)} "
                f"&& test ! -L {shlex.quote(NODE_RUNTIME_TARBALL_TARGET)} "
                f"&& sha256sum {shlex.quote(NODE_RUNTIME_TARBALL_TARGET)}"
            ),
            timeout_sec=30,
        )
        uploaded_sha256 = sha256_from_output(remote_hash.stdout)
        if uploaded_sha256 != self.node_runtime_sha256:
            raise RuntimeError(
                "ligule_node_runtime_upload_sha256_mismatch: "
                f"expected {self.node_runtime_sha256}, received {uploaded_sha256 or 'no_digest'}"
            )

        await self.exec_as_agent(
            environment,
            command=(
                f"tar --no-same-owner -xzf {shlex.quote(NODE_RUNTIME_TARBALL_TARGET)} "
                f"--strip-components=1 -C {shlex.quote(NODE_RUNTIME_DIRECTORY)}"
            ),
            timeout_sec=120,
        )
        self.node_bin_directory = NODE_RUNTIME_BIN
        if not await self._node_runtime_ready(environment):
            raise RuntimeError("ligule_node_runtime_invalid")
        await self.exec_as_agent(
            environment,
            command=f"rm -- {shlex.quote(NODE_RUNTIME_TARBALL_TARGET)}",
            timeout_sec=30,
        )

    async def _install_native_build_tools(self, environment: BaseEnvironment) -> None:
        if not self.ligule_install_build_tools:
            return
        try:
            await self.exec_as_agent(
                environment,
                command=(
                    "command -v make >/dev/null 2>&1 && "
                    "command -v g++ >/dev/null 2>&1 && "
                    "command -v python3 >/dev/null 2>&1"
                ),
                timeout_sec=30,
            )
            return
        except NonZeroAgentExitCodeError:
            pass

        proxy_env = None
        if self.ligule_setup_proxy_url is not None:
            proxy_env = {
                name: self.ligule_setup_proxy_url
                for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy")
            }
        apt_command = (
            tsinghua_apt_setup_command()
            if self.ligule_setup_apt_mirror == "tsinghua"
            else (
                "apt-get update && DEBIAN_FRONTEND=noninteractive "
                "apt-get install -y --no-install-recommends build-essential python3"
            )
        )
        await self.exec_as_root(
            environment,
            command=apt_command,
            env=proxy_env,
            timeout_sec=900,
        )

    async def install(self, environment: BaseEnvironment) -> None:
        node_runtime_ready = await self._node_runtime_ready(environment)
        if not node_runtime_ready and self.node_runtime_path is None:
            raise RuntimeError("ligule_requires_node_24_or_newer")
        await self._prepare_install_prefix(environment)
        if not node_runtime_ready:
            await self._install_node_runtime(environment)
        await self._install_native_build_tools(environment)
        await self._upload_agent_owned_file(environment, self.tarball_path, TARBALL_TARGET)
        remote_hash = await self.exec_as_agent(
            environment,
            command=self._with_node_path(
                "node -e " + shlex.quote(
                    "const fs=require('node:fs');const c=require('node:crypto');"
                    "process.stdout.write(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))"
                ) + f" {shlex.quote(TARBALL_TARGET)}"
            ),
            timeout_sec=30,
        )
        if sha256_from_output(remote_hash.stdout) != self.package["sha256"]:
            raise RuntimeError("ligule_uploaded_tarball_digest_mismatch")
        await self.exec_as_agent(
            environment,
            command=self._with_node_path(
                f"npm install --prefix {shlex.quote(INSTALL_PREFIX)} {shlex.quote(TARBALL_TARGET)} "
                "--no-audit --no-fund"
            ),
            timeout_sec=900,
        )
        probe = (
            "Promise.all([import('@ligule/core/session/atif.js'),import('@ligule/core/kernel/result.js')])"
            ".then(([a,r])=>{if(typeof a.sessionTurnToAtif!=='function'||!(r.SPILL_NAME instanceof RegExp))process.exitCode=1})"
        )
        await self.exec_as_agent(
            environment,
            command=f"cd {shlex.quote(PACKAGE_ROOT)} && " + self._with_node_path(
                f"node --input-type=module -e {shlex.quote(probe)}"
            ),
            timeout_sec=30,
        )

    async def setup(self, environment: BaseEnvironment) -> None:
        with environment.scoped_exec_env({self.ligule_api_key_env: ""}):
            await super().setup(environment)
            source = Path(__file__).with_name("export_session.mjs")
            policy_source = Path(__file__).with_name("policy-mode.mjs")
            await self.exec_as_agent(
                environment,
                command=f"test ! -e {shlex.quote(REMOTE_EXPORTER)}",
                timeout_sec=30,
            )
            await self._upload_agent_owned_file(environment, source, REMOTE_EXPORTER)
            await self._upload_agent_owned_file(environment, policy_source, REMOTE_POLICY_MODE)

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        api_key = self.extra_env.get(self.ligule_api_key_env)
        if api_key is None or api_key == "":
            raise RuntimeError("ligule_provider_credential_missing")
        trial_id = uuid.uuid4().hex
        home = f"/tmp/ligule-eval-{trial_id}"
        sessions = f"{home}/sessions"
        instruction_path = f"{home}/instruction.txt"
        logs_path = self.environment_logs_dir.as_posix()
        with environment.scoped_exec_env({self.ligule_api_key_env: ""}):
            await self.exec_as_agent(
                environment,
                command=f"mkdir -p {shlex.quote(home)}",
                timeout_sec=30,
            )
            with tempfile.TemporaryDirectory(prefix="ligule-harbor-instruction-") as temporary:
                source = Path(temporary) / "instruction.txt"
                source.write_text(instruction, encoding="utf-8")
                await self._upload_agent_owned_file(environment, source, instruction_path)

        arguments = [
            "node", REMOTE_EXPORTER, "run",
            "--instruction-file", instruction_path,
            "--session-directory", sessions,
            "--home-directory", home,
            "--logs-directory", logs_path,
            "--cli", f"{INSTALL_PREFIX}/node_modules/.bin/ligule",
            "--agent-version", self.package["version"],
            "--model-api", self.ligule_api,
            "--base-url", self.ligule_base_url,
            "--model", self.ligule_model,
            "--api-key-env", self.ligule_api_key_env,
            "--model-calls", str(self.ligule_model_calls),
            "--timeout-ms", str(self.ligule_timeout_ms),
            "--request-timeout-ms", str(self.ligule_request_timeout_ms),
        ]
        if self.ligule_output_tokens is not None:
            arguments.extend(("--output-tokens", str(self.ligule_output_tokens)))
        command = self._with_node_path(" ".join(shlex.quote(argument) for argument in arguments))
        try:
            await self.exec_as_agent(
                environment,
                command=command,
                env={"LIGULE_HOME": home, self.ligule_api_key_env: api_key},
                timeout_sec=(self.ligule_timeout_ms + 30_000 + 999) // 1000,
            )
        finally:
            self._last_trial = {"home": home, "session_directory": sessions}

    def populate_context_post_run(self, context: AgentContext) -> None:
        if self._last_trial is None:
            return
        status_path = self.logs_dir / "ligule-result.json"
        if not status_path.is_file() or status_path.is_symlink():
            context.metadata = {**(context.metadata or {}), "ligule": {"state": "unknown", "result_file_missing": True}}
            return
        try:
            value = json.loads(status_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            context.metadata = {**(context.metadata or {}), "ligule": {"state": "unknown", "result_file_invalid": True}}
            return
        allowed = ("status", "state", "sessionId", "runId", "errorCode", "atifErrorCode")
        context.metadata = {**(context.metadata or {}), "ligule": {key: value[key] for key in allowed if key in value}}
