// multipart.js — a small, strict multipart/form-data parser for the one upload form of
// the dashboard (an evidence image), so no dependency is needed.
//
// The raw body is read by express.raw with a hard size limit first; this parser then
// accepts at most `maxParts` parts, short text fields, and at most one file of at most
// `maxFileBytes`. Images are recognised by their first bytes (magic numbers), never by
// the browser's Content-Type or the file name.

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_FIELD_BYTES = 4096;
const MAX_HEADER_BYTES = 1024;

export class MultipartError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = 'MultipartError';
        this.userMessage = message;
        this.status = status;
    }
}

/** The boundary of a multipart/form-data Content-Type header, or null. */
export function boundaryOf(contentType) {
    const value = String(contentType || '');
    if (!/^multipart\/form-data\s*;/i.test(value)) return null;
    const match = value.match(/;\s*boundary=(?:"([^"]{1,70})"|([^\s;"]{1,70}))/i);
    return match ? (match[1] || match[2]) : null;
}

function headerParams(headerBlock) {
    const headers = {};
    for (const line of headerBlock.split('\r\n')) {
        const index = line.indexOf(':');
        if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    }
    const disposition = headers['content-disposition'] || '';
    if (!/^form-data\s*;/i.test(disposition)) throw new MultipartError('Malformed upload (no form-data part).');
    const name = disposition.match(/;\s*name="([^"\r\n]{1,100})"/i)?.[1];
    if (!name) throw new MultipartError('Malformed upload (a part has no name).');
    const filenameMatch = disposition.match(/;\s*filename="([^"\r\n]{0,200})"/i);
    return { name, filename: filenameMatch ? filenameMatch[1] : null, contentType: headers['content-type'] || null };
}

/**
 * Parses a multipart body (Buffer). Returns { fields: { name: string }, file: { field,
 * filename, declaredType, data } | null }. Repeated text fields keep the first value.
 * Throws MultipartError (userMessage, status 400/413) for anything unexpected.
 */
export function parseMultipart(body, contentType, { maxFileBytes = MAX_UPLOAD_BYTES, maxParts = 8 } = {}) {
    const boundary = boundaryOf(contentType);
    if (!boundary) throw new MultipartError('This form must be sent as multipart/form-data.');
    if (!Buffer.isBuffer(body) || body.length === 0) throw new MultipartError('The upload was empty.');

    const delimiter = Buffer.from(`--${boundary}`);
    const fields = {};
    let file = null;
    let position = body.indexOf(delimiter);
    if (position !== 0) throw new MultipartError('Malformed upload.');
    let parts = 0;

    while (true) {
        position += delimiter.length;
        // "--" after a delimiter ends the body.
        if (body[position] === 0x2d && body[position + 1] === 0x2d) break;
        if (body[position] !== 0x0d || body[position + 1] !== 0x0a) throw new MultipartError('Malformed upload.');
        position += 2;
        parts += 1;
        if (parts > maxParts) throw new MultipartError('Too many fields in the upload.');

        const headerEnd = body.indexOf('\r\n\r\n', position);
        if (headerEnd === -1 || headerEnd - position > MAX_HEADER_BYTES) throw new MultipartError('Malformed upload.');
        const meta = headerParams(body.subarray(position, headerEnd).toString('utf8'));
        const dataStart = headerEnd + 4;
        const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delimiter]), dataStart);
        if (next === -1) throw new MultipartError('Malformed upload (truncated).');
        const data = body.subarray(dataStart, next);

        if (meta.filename !== null) {
            if (file) throw new MultipartError('Upload one image at a time.');
            if (data.length > maxFileBytes) throw new MultipartError(`The image is larger than ${Math.floor(maxFileBytes / 1024 / 1024)} MB.`, 413);
            if (data.length > 0) file = { field: meta.name, filename: meta.filename, declaredType: meta.contentType, data: Buffer.from(data) };
        } else {
            if (data.length > MAX_FIELD_BYTES) throw new MultipartError('A text field in the upload is too long.');
            if (!Object.hasOwn(fields, meta.name)) fields[meta.name] = data.toString('utf8');
        }
        position = next + 2;
    }
    return { fields, file };
}

const IMAGE_TYPES = [
    { type: 'image/png', ext: 'png', test: (b) => b.length > 8 && b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
    { type: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { type: 'image/gif', ext: 'gif', test: (b) => b.length > 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')) },
    { type: 'image/webp', ext: 'webp', test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

/** { type, ext } of a PNG / JPEG / GIF / WebP judged by its first bytes, or null. */
export function sniffImage(data) {
    if (!Buffer.isBuffer(data)) return null;
    const found = IMAGE_TYPES.find((t) => t.test(data));
    return found ? { type: found.type, ext: found.ext } : null;
}

/** A safe file name for the re-hosted image: evidence-<case>.<ext>. */
export function evidenceFileName(caseCode, ext) {
    return `evidence-${String(caseCode).replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || 'case'}.${ext}`;
}
