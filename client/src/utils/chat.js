export const CHATGPT_DEFAULT_URL = 'https://chatgpt.com/?model=gpt-5-thinking';

export function openChatGpt(targetUrl = CHATGPT_DEFAULT_URL) {
  const normalizedUrl = typeof targetUrl === 'string' && targetUrl.trim() ? targetUrl.trim() : CHATGPT_DEFAULT_URL;

  if (typeof window !== 'undefined') {
    window.open(normalizedUrl, '_blank', 'noopener');
  }
}

export default openChatGpt;
