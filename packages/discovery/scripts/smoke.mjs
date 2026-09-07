import { exerciseLocal } from "../test/local-scenario.mjs";
console.log(JSON.stringify(await exerciseLocal(), null, 2));
