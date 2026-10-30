# Patch sandbox image (DESIGN §18.7, §19; TECHNICAL §5.6).
#
# One image serves both container kinds the launcher creates: synthesis (`muse serve`
# with the agent) and test (the independent pytest run, no key, no network).
#
# Build from the repo root; the S1 scenario directory is a named build context:
#   docker build -f sandbox/Dockerfile \
#     --build-context s1=services/twin/twin/scenarios/s1 -t chronosight-sandbox .
# Pin the result by digest in SANDBOX_IMAGE. Rebuild only on purpose.
#
# PlatformIO is not installed yet: S1's targetFiles are Python only, so the compile
# check (FR-PAT-3) has nothing to compile. SP-6 adds the toolchain here.

FROM python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir numpy==2.5.4 pytest==9.2.0

# Muse Code CLI, installed only here and never on a host (stable channel, no updater).
ARG MUSE_VERSION_PREFIX=1.4.14-
ENV MUSE_INSTALL_DIR=/opt/muse/bin \
    MUSE_NO_AUTO_UPDATE=1 \
    MUSE_LOGIN=0
RUN curl -fsSL --proto '=https' --tlsv1.2 https://dev.meta.ai/install.sh -o /tmp/muse-install.sh \
 && HOME=/root bash /tmp/muse-install.sh </dev/null \
 && rm -f /tmp/muse-install.sh \
 && v="$(cat /opt/muse/bin/.muse-version)" \
 && case "$v" in "$MUSE_VERSION_PREFIX"*) echo "muse $v" ;; *) echo "unexpected muse version: $v" >&2; exit 1 ;; esac \
 && chmod -R a-w /opt/muse

# The read-only S1 harness. The plant and the controller both import `abi`, which
# sits beside them on the sim path.
COPY --from=s1 baseline/abi.py plant.py sim_harness/step.py /opt/chronosight/s1/sim_harness/
COPY --from=s1 tests/test_step_response.py /opt/chronosight/s1/tests/
RUN chmod -R a-w /opt/chronosight

# /workspace is seeded into each fresh per-candidate volume on first mount. tests/ and
# sim_harness/ point into the read-only root, so neither the agent nor candidate code
# can change them (TH-5); the agent's own `pytest` still finds them under /workspace.
RUN groupadd -g 10001 sbx \
 && useradd -u 10001 -g 10001 -M -d /tmp/home -s /usr/sbin/nologin sbx \
 && mkdir /workspace \
 && ln -s /opt/chronosight/s1/tests /workspace/tests \
 && ln -s /opt/chronosight/s1/sim_harness /workspace/sim_harness \
 && chown -h 10001:10001 /workspace /workspace/tests /workspace/sim_harness

# No bytecode or pytest cache in the git-tracked workspace, so the diff holds only
# the agent's edits (§17.4). HOME is on the /tmp tmpfs because the root is read-only.
ENV PATH=/opt/muse/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTEST_ADDOPTS="-p no:cacheprovider" \
    CS_WORKSPACE=/workspace \
    HOME=/tmp/home

USER 10001:10001
WORKDIR /workspace
