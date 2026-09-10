import { loadOperatorInputs, validateOperatorInputs } from './mycelium-operator.mjs';
try {
  if (process.argv.length !== 3) throw Error('USAGE_OPERATOR_CHECK_PRIVATE_JSON');
  console.log(JSON.stringify(validateOperatorInputs(loadOperatorInputs(process.argv[2])),null,2));
} catch (e) {
  const code=e?.code ?? e?.message;
  console.error(/^[A-Z][A-Z0-9_]*$/.test(code)?code:'INVALID_OPERATOR_INPUTS');
  process.exitCode=1;
}
