import { MAX_TOKEN_LENGTH, sanitizeConfig } from '../site/config.js';

export { MAX_SOURCES, MAX_TOKEN_LENGTH, assertPublicHttps, sanitizeConfig } from '../site/config.js';

export function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeBase64Url(token) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('Configuration link is invalid or too long.');
  }
  const base64 = token.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - token.length % 4) % 4);
  let bytes;
  try {
    const binary = atob(base64);
    bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    throw new Error('Configuration link could not be decoded.');
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function encodeConfig(config) {
  return encodeBase64Url(sanitizeConfig(config));
}

export function decodeConfig(token) {
  return sanitizeConfig(decodeBase64Url(token));
}
