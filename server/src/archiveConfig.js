// Where archived files live, shared by the server (archive.js) and the upload
// worker (archiveWorker.js). No imports on purpose: the worker must not open
// the database just to learn a bucket name.
//
// Env (endpoint, region and keys fall back to the backup ones — same project):
//   FILES_S3_BUCKET     a PRIVATE bucket, e.g. votask-files. Unset = archiving off.
//   FILES_S3_ENDPOINT / FILES_S3_REGION / FILES_S3_ACCESS_KEY_ID / FILES_S3_SECRET_ACCESS_KEY
const env = process.env

export function archiveS3Config() {
  return {
    endpoint: (env.FILES_S3_ENDPOINT || env.BACKUP_S3_ENDPOINT || '').replace(/\/+$/, ''),
    region: env.FILES_S3_REGION || env.BACKUP_S3_REGION || 'us-east-1',
    bucket: env.FILES_S3_BUCKET || '',
    accessKeyId: env.FILES_S3_ACCESS_KEY_ID || env.BACKUP_S3_ACCESS_KEY_ID || '',
    secretAccessKey: env.FILES_S3_SECRET_ACCESS_KEY || env.BACKUP_S3_SECRET_ACCESS_KEY || '',
  }
}

export const archiveConfigured = () => {
  const c = archiveS3Config()
  return !!(c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey)
}

// A file is kept as raw (uncompressed: photos and videos are compressed
// already, and a Range request must map straight onto bytes) parts of 16 MB.
// Supabase refuses any single object over 50 MB while its spend cap is on, and
// the upload worker holds one part in memory at a time.
export const ARCHIVE_PART_BYTES = 16 * 1024 * 1024
export const partKey = (remote, i) => `files/${remote}/part-${String(i + 1).padStart(4, '0')}`
export const remotePrefix = (remote) => `files/${remote}/`
