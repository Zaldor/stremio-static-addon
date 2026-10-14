export async function readApiJson(response, action = 'Request') {
  const body = await response.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    const isHtml = /text\/html/i.test(response.headers.get('content-type') || '') ||
      /^\s*<(?:!doctype\s+html|html\b)/i.test(body);
    if (isHtml) {
      const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
        ?.replace(/\s+/g, ' ').trim().slice(0, 120);
      const code = body.match(/(?:Cloudflare\s+)?Error code:\s*(\d{3,})/i)?.[1];
      const details = [`HTTP ${response.status}`, title && `“${title}”`, code && `error code ${code}`]
        .filter(Boolean).join('; ');
      throw new Error(`${action} received an HTML page instead of JSON (${details}). The Worker did not return its own error message.`);
    }
    throw new Error(`${action} returned an invalid response (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    throw new Error(typeof data?.error === 'string' ? data.error : `${action} failed (HTTP ${response.status}).`);
  }
  return data;
}
