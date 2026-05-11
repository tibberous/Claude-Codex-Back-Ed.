/* Smoke test: invoke submitText() with a known string so we can confirm the post-Whisper
   paste-to-chat chain is wired end to end without actually recording audio.
   POST { text: "..." } and watch claude-vscode focus → clipboard → paste → Enter. */
module.exports = async function ({ submitText, cvLog, body }) {
    const text = (body && body.text) || '[CBE-SMOKE] If you see this in the chat input, the post-Whisper paste chain works.';
    cvLog('test-submit invoked text=' + JSON.stringify(text.slice(0, 80)));
    await submitText(text);
    return { ok: true, sent: text };
};
