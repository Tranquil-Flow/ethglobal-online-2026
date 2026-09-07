import {readFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
const lanes=JSON.parse(readFileSync('docs/lanes.json','utf8'));
assert.equal(Object.keys(lanes).length,5);
for(const [lane,entry] of Object.entries(lanes)) {
 for(const path of [`docs/lanes/${lane}.md`,`docs/handoffs/${lane}.json`,`packages/${lane}/README.md`]) assert.ok(existsSync(path),path);
 assert.equal(entry.branch,`lane/${lane}`);
 assert.ok(readFileSync('docs/GOALS.md','utf8').includes(entry.worktree));
 assert.equal(JSON.parse(readFileSync(`docs/handoffs/${lane}.json`)).lane,lane);
}
for(const path of ['AGENTS.md','docs/ARCHITECTURE.md','docs/PORTS.md','docs/HTTP.md','docs/RELEASE.md','docs/INTEGRATION.md','docs/PROVENANCE.md']) assert.ok(existsSync(path),path);
console.log('Bootstrap layout valid; application lanes are not implied ready.');
