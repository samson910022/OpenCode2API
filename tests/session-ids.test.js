import { isValidSessionId, isValidMessageId } from '../src/session/ids.js';

// Canonical shapes: "ses_"/"msg_" + 12 lowercase hex + 14 base62
// (upstream packages/schema/src/identifier.ts). Built explicitly so a
// regex length change fails loudly instead of silently slicing wrong.
const HEX12 = '0123456789ab'; // 12 lowercase hex
const BASE62_14 = 'cdefABCDEFGHIJ'; // 14 base62
const goodSes = `ses_${HEX12}${BASE62_14}`;
const goodMsg = `msg_${HEX12}${BASE62_14}`;

describe('session/message ID validators', () => {
    test('accepts canonical backend-minted IDs', () => {
        expect(isValidSessionId(goodSes)).toBe(true);
        expect(isValidMessageId(goodMsg)).toBe(true);
    });

    test('rejects cross-prefix and malformed IDs', () => {
        expect(isValidSessionId(goodMsg)).toBe(false);
        expect(isValidMessageId(goodSes)).toBe(false);
        expect(isValidSessionId('ses_short')).toBe(false);
        expect(isValidSessionId('ses_0123456789ABCDEFABCDEFGHIJKLMN'.slice(0, 30))).toBe(false); // uppercase hex
        expect(isValidSessionId('')).toBe(false);
    });

    test('rejects non-strings and forged prj_ IDs', () => {
        expect(isValidSessionId(undefined)).toBe(false);
        expect(isValidSessionId(null)).toBe(false);
        expect(isValidSessionId(123)).toBe(false);
        expect(isValidMessageId({})).toBe(false);
        // x-opencode-project has no prj_ prefix upstream; it must never
        // validate as a session/message ID.
        expect(isValidSessionId('prj_0123456789abcdefABCDEFGHIJKLMN'.slice(0, 30))).toBe(false);
        expect(isValidMessageId('prj_0123456789abcdefABCDEFGHIJKLMN'.slice(0, 30))).toBe(false);
    });
});
