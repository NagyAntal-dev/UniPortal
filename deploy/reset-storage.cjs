// Executed inside the existing Storage container; credentials stay there.
// Object metadata comes from psql on stdin. Delete through the Storage API so
// both metadata and physical files are removed (never DELETE storage.objects).
const fs = require('node:fs');

async function main() {
  const objects = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!process.env.SERVICE_KEY) throw new Error('Storage SERVICE_KEY is missing');
  const buckets = new Map();
  for (const { bucket_id, name } of objects) {
    if (bucket_id === 'avatars') throw new Error('Refusing to delete user avatars');
    if (!buckets.has(bucket_id)) buckets.set(bucket_id, []);
    buckets.get(bucket_id).push(name);
  }
  for (const [bucket, names] of buckets) {
    for (let i = 0; i < names.length; i += 1000) {
      const response = await fetch(`http://127.0.0.1:5000/object/${encodeURIComponent(bucket)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${process.env.SERVICE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prefixes: names.slice(i, i + 1000) }),
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) throw new Error(`Storage deletion failed for ${bucket}: HTTP ${response.status}`);
      console.log(`[reset] Deleted ${Math.min(1000, names.length - i)} files from ${bucket}`);
    }
  }
}

main().catch(error => { console.error(`[reset] ${error.message}`); process.exitCode = 1; });
