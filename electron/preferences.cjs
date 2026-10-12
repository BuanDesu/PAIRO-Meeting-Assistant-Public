const fs = require('node:fs/promises');
const path = require('node:path');

function sanitizePreferences(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, limit] of Object.entries({ signalBase: 2048, endpoint: 2048, model: 256 })) {
    if (typeof value[key] === 'string') result[key] = value[key].trim().slice(0, limit);
  }
  return result;
}

function createPreferencesStore(directory) {
  const file = path.join(directory, 'preferences.json');
  let writes = Promise.resolve();
  return {
    async read() {
      await writes.catch(() => {});
      try { return sanitizePreferences(JSON.parse(await fs.readFile(file, 'utf8'))); }
      catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
        throw error;
      }
    },
    write(value) {
      const preferences = sanitizePreferences(value);
      const write = writes.catch(() => {}).then(async () => {
        await fs.mkdir(directory, { recursive: true });
        const temporary = file + '.tmp';
        await fs.writeFile(temporary, JSON.stringify(preferences), { mode: 0o600 });
        await fs.rename(temporary, file);
        return preferences;
      });
      writes = write;
      return write;
    },
  };
}

module.exports = { sanitizePreferences, createPreferencesStore };
