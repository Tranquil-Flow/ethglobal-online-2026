import {digestOf, validate} from "../packages/contracts/index.mjs";
import {createNativeExecutionAdapter} from "./mycelium-native.mjs";
import {validateRuntimeProfileV1} from "./mycelium-gateway-v3.mjs";

export function createV3NativeExecutionAdapter({workbenchProfile, runtimeProfile, validateRequest,
  openSession, timeoutMs = 30000, maxOutputBytes = 1048576} = {}) {
  validate("Profile", workbenchProfile);
  const profile = structuredClone(workbenchProfile), runtime = validateRuntimeProfileV1(runtimeProfile);
  const runtimeProfileId = digestOf(runtime), mode = runtime.runtime.execution_kind === "conformance" ? "development" : "live";
  // Validate construction eagerly; constructors perform no network actions.
  const options = {profile, mode, validateRequest, openSession, timeoutMs, maxOutputBytes, allowDecoderFlush: true};
  createNativeExecutionAdapter(options);
  return Object.freeze({
    mode, profile: structuredClone(profile), validateRequest,
    async *execute(input) {
      let binding;
      const requestHash = digestOf(input.request);
      const scopedOpen = async (args) => {
        const session = await openSession(args);
        return {...session, async *events(options) {
          for await (const event of session.events(options)) {
            if (event.type === "accepted") {
              if (event.runtimeProfileId !== runtimeProfileId || event.gatewayBinding?.profile_id !== runtimeProfileId) throw Error("RUNTIME_PROFILE_MISMATCH");
              binding = structuredClone(event.gatewayBinding);
            }
            yield event;
          }
        }};
      };
      const adapter = createNativeExecutionAdapter({...options, openSession: scopedOpen});
      for await (const event of adapter.execute(input)) {
        if (event.type === "completed") {
          if (!binding) throw Error("MISSING_NATIVE_BINDING");
          yield {...event, evidenceDigest: digestOf({protocol: "workbench.native-execution.v3", profileId: event.profileId,
            requestHash, runtimeProfileId, binding, output: event.output})};
        } else yield event;
      }
    },
  });
}
