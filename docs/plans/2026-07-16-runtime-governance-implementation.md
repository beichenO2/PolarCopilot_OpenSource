# PolarCopilot runtime governance implementation plan

1. Record R9 as `in-progress` and declare both governed services in
   `polaris.json`.
2. Add a failing runtime-contract test covering launchers, registration,
   forbidden lifecycle controls, PolarPort-only discovery, and SSoT.
3. Add the two foreground launchers and the registration-only script.
4. Change Hub discovery and claim failure handling to require PolarPort.
5. Run contract tests, shell syntax checks, Hub build, Web tests/build, VSCode
   compile, and the project governance audit.
6. Record verification as `tested`, then register both existing service IDs in
   place without touching the live Hub lifecycle.
7. Normalize only `polarcop-web-dev` with its exact PolarProcess stop endpoint.
8. Recheck Hub PID/health/owner and Web Dev stopped/listener state, then mark R9
   `done` with dated evidence.

