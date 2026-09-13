import { defineSandbox } from 'eve/sandbox';

// Eve otherwise supplies an automatic VM/container backend. Host tools do not
// call getSandbox; fail explicitly if a future tool tries to open one.
export default defineSandbox({
  backend: {
    name: 'disabled',
    async prewarm() { return { reused: true }; },
    async create() { throw new Error('Sandbox disabled. Use the local filesystem and Bash tools.'); },
  },
});
