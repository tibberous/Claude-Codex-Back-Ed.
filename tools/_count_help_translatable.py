"""Estimate translatable text + cost for help.html localization."""
import re
from pathlib import Path

p = Path(__file__).resolve().parent.parent / "panel" / "help.html"
text = p.read_text(encoding="utf-8")
text_no_css = re.sub(r"<style[\s\S]*?</style>", "", text, flags=re.I)
text_no_js  = re.sub(r"<script[\s\S]*?</script>", "", text_no_css, flags=re.I)
contents = re.findall(r">([^<]+)<", text_no_js)
total_chars = sum(len(s.strip()) for s in contents if s.strip())
approx_tokens = total_chars // 3
n_langs = 38
print(f"Translatable text: {total_chars} chars (~{approx_tokens} tokens)")
print(f"Total file: {p.stat().st_size} bytes")
# Haiku 4.5: $0.80 input + $4 output per MTok
# Send full file as input (input matters more than output since output ≈ same size)
input_per_lang_tokens = len(text) // 3
output_per_lang_tokens = approx_tokens  # roughly same
cost_in  = input_per_lang_tokens  * n_langs * 0.80 / 1_000_000
cost_out = output_per_lang_tokens * n_langs * 4.00 / 1_000_000
print(f"Per language: ~{input_per_lang_tokens} in + ~{output_per_lang_tokens} out tokens")
print(f"Estimated cost across {n_langs} languages: ~${cost_in + cost_out:.2f}")
