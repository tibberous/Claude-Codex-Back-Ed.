#!/usr/bin/env python3
"""Add the 6 missing toolbar-tooltip i18n keys to every languages/*.xml.

Keys added (idempotent — skips any already present):
  tooltip.accounts, tooltip.browser, tooltip.tamagotchi,
  ext.calculator, ext.minesweeper, ext.emoji-picker

Background: the Accounts / Browser / Tamagotchi buttons and the three demo
extensions (Calculator / Minesweeper / Emoji Picker) had no i18n strings, so
their tooltips stayed English in every locale. index.html now carries the
data-i18n-tip hooks and panel.js looks up `ext.<id>`; this fills in the strings.

Inserted right before </strings> (XML key order is cosmetic — applyI18n builds
a flat map). Run:  python tools/add_tooltip_i18n.py
"""
import re, sys
from pathlib import Path

LANG_DIR = Path(__file__).resolve().parent.parent / "languages"

KEYS = ["tooltip.accounts", "tooltip.browser", "tooltip.tamagotchi",
        "ext.calculator", "ext.minesweeper", "ext.emoji-picker"]

# locale -> {key: translation}. English source:
#   accounts="Accounts — manage API keys"  browser="Browser"
#   tamagotchi="Tamagotchi pet"  calculator="Calculator"
#   minesweeper="Minesweeper"  emoji-picker="Emoji Picker"
T = {
 "en": ["Accounts — manage API keys","Browser","Tamagotchi pet","Calculator","Minesweeper","Emoji Picker"],
 "ar": ["الحسابات — إدارة مفاتيح API","المتصفح","حيوان تاماغوتشي","الآلة الحاسبة","كانسة الألغام","منتقي الإيموجي"],
 "bn": ["অ্যাকাউন্ট — API কী পরিচালনা করুন","ব্রাউজার","তামাগোচি পোষা","ক্যালকুলেটর","মাইনসুইপার","ইমোজি পিকার"],
 "cs": ["Účty — správa klíčů API","Prohlížeč","Mazlíček Tamagotchi","Kalkulačka","Hledání min","Výběr emoji"],
 "da": ["Konti — administrer API-nøgler","Browser","Tamagotchi-kæledyr","Lommeregner","Minestryger","Emoji-vælger"],
 "de": ["Konten — API-Schlüssel verwalten","Browser","Tamagotchi-Haustier","Rechner","Minesweeper","Emoji-Auswahl"],
 "el": ["Λογαριασμοί — διαχείριση κλειδιών API","Πρόγραμμα περιήγησης","Κατοικίδιο Tamagotchi","Αριθμομηχανή","Ναρκαλιευτής","Επιλογέας emoji"],
 "es": ["Cuentas — administrar claves de API","Navegador","Mascota Tamagotchi","Calculadora","Buscaminas","Selector de emojis"],
 "fa": ["حساب‌ها — مدیریت کلیدهای API","مرورگر","حیوان خانگی تاماگوچی","ماشین‌حساب","مین‌روب","انتخاب‌گر ایموجی"],
 "fi": ["Tilit — hallitse API-avaimia","Selain","Tamagotchi-lemmikki","Laskin","Miinaharava","Emoji-valitsin"],
 "fr": ["Comptes — gérer les clés API","Navigateur","Animal Tamagotchi","Calculatrice","Démineur","Sélecteur d'émojis"],
 "ha": ["Asusu — sarrafa makullan API","Birawsa","Dabbar Tamagotchi","Na'urar lissafi","Minesweeper","Mai zaɓen emoji"],
 "he": ["חשבונות — ניהול מפתחות API","דפדפן","חיית מחמד טמגוצ'י","מחשבון","שולה מוקשים","בורר אימוג'י"],
 "hi": ["खाते — API कुंजियाँ प्रबंधित करें","ब्राउज़र","तामागोची पालतू","कैलकुलेटर","माइनस्वीपर","इमोजी चयनकर्ता"],
 "hu": ["Fiókok — API-kulcsok kezelése","Böngésző","Tamagotchi kisállat","Számológép","Aknakereső","Emoji-választó"],
 "id": ["Akun — kelola kunci API","Peramban","Peliharaan Tamagotchi","Kalkulator","Minesweeper","Pemilih emoji"],
 "it": ["Account — gestisci le chiavi API","Browser","Animaletto Tamagotchi","Calcolatrice","Campo minato","Selettore emoji"],
 "ja": ["アカウント — APIキーの管理","ブラウザ","たまごっち（ペット）","電卓","マインスイーパ","絵文字ピッカー"],
 "ko": ["계정 — API 키 관리","브라우저","다마고치 펫","계산기","지뢰 찾기","이모지 선택기"],
 "mr": ["खाती — API की व्यवस्थापित करा","ब्राउझर","तामागोची पाळीव प्राणी","कॅल्क्युलेटर","माइनस्वीपर","इमोजी निवडक"],
 "nb": ["Kontoer — administrer API-nøkler","Nettleser","Tamagotchi-kjæledyr","Kalkulator","Minesveiper","Emoji-velger"],
 "nl": ["Accounts — API-sleutels beheren","Browser","Tamagotchi-huisdier","Rekenmachine","Mijnenveger","Emoji-kiezer"],
 "pa": ["ਖਾਤੇ — API ਕੁੰਜੀਆਂ ਪ੍ਰਬੰਧਿਤ ਕਰੋ","ਬ੍ਰਾਊਜ਼ਰ","ਤਾਮਾਗੋਚੀ ਪਾਲਤੂ","ਕੈਲਕੁਲੇਟਰ","ਮਾਈਨਸਵੀਪਰ","ਇਮੋਜੀ ਚੋਣਕਾਰ"],
 "pl": ["Konta — zarządzaj kluczami API","Przeglądarka","Pupil Tamagotchi","Kalkulator","Saper","Wybór emoji"],
 "pt": ["Contas — gerir chaves de API","Navegador","Mascote Tamagotchi","Calculadora","Campo minado","Seletor de emojis"],
 "ro": ["Conturi — gestionează cheile API","Browser","Animăluț Tamagotchi","Calculator","Detector de mine","Selector emoji"],
 "ru": ["Аккаунты — управление ключами API","Браузер","Питомец Тамагочи","Калькулятор","Сапёр","Выбор эмодзи"],
 "sv": ["Konton — hantera API-nycklar","Webbläsare","Tamagotchi-husdjur","Miniräknare","Minröj","Emoji-väljare"],
 "sw": ["Akaunti — dhibiti funguo za API","Kivinjari","Mnyama wa Tamagotchi","Kikokotoo","Minesweeper","Kichagua emoji"],
 "ta": ["கணக்குகள் — API விசைகளை நிர்வகி","உலாவி","தாமகோச்சி செல்லப்பிராணி","கணிப்பான்","மைன்ஸ்வீப்பர்","எமோஜி தேர்வி"],
 "te": ["ఖాతాలు — API కీలను నిర్వహించండి","బ్రౌజర్","తామగోచి పెంపుడు","కాలిక్యులేటర్","మైన్‌స్వీపర్","ఎమోజీ ఎంపిక"],
 "th": ["บัญชี — จัดการคีย์ API","เบราว์เซอร์","สัตว์เลี้ยงทามาก็อตจิ","เครื่องคิดเลข","เกมกู้ระเบิด","ตัวเลือกอีโมจิ"],
 "tl": ["Mga account — pamahalaan ang mga API key","Browser","Alagang Tamagotchi","Calculator","Minesweeper","Pampili ng emoji"],
 "tr": ["Hesaplar — API anahtarlarını yönet","Tarayıcı","Tamagotchi evcil hayvanı","Hesap makinesi","Mayın tarlası","Emoji seçici"],
 "uk": ["Облікові записи — керування ключами API","Браузер","Улюбленець Тамагочі","Калькулятор","Сапер","Вибір емодзі"],
 "ur": ["اکاؤنٹس — API کلیدوں کا انتظام","براؤزر","تاماگوچی پالتو","کیلکولیٹر","مائن سویپر","ایموجی منتخب کنندہ"],
 "vi": ["Tài khoản — quản lý khóa API","Trình duyệt","Thú cưng Tamagotchi","Máy tính","Dò mìn","Bộ chọn emoji"],
 "yue": ["帳戶 — 管理 API 金鑰","瀏覽器","Tamagotchi 寵物","計算機","掃雷","Emoji 選擇器"],
 "zh": ["账户 — 管理 API 密钥","浏览器","Tamagotchi 宠物","计算器","扫雷","表情选择器"],
}

def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def main():
    files = sorted(LANG_DIR.glob("*.xml"))
    if not files:
        print("No language files found at", LANG_DIR); sys.exit(1)
    ok, missing_loc, problems = 0, [], []
    for f in files:
        loc = f.stem
        text = f.read_text(encoding="utf-8")
        vals = T.get(loc) or T.get("en")
        if loc not in T:
            missing_loc.append(loc)
        new_lines = []
        for key, val in zip(KEYS, vals):
            if re.search(r'id="%s"' % re.escape(key), text):
                continue  # already present — idempotent
            new_lines.append('  <s id="%s">%s</s>' % (key, esc(val)))
        if new_lines:
            block = "\n".join(new_lines) + "\n</strings>"
            if "</strings>" not in text:
                problems.append(loc + " (no </strings>)"); continue
            text = text.replace("</strings>", block, 1)
            f.write_text(text, encoding="utf-8")
        # verify all 6 keys present now
        after = f.read_text(encoding="utf-8")
        have = [k for k in KEYS if re.search(r'id="%s"' % re.escape(k), after)]
        if len(have) == len(KEYS):
            ok += 1
        else:
            problems.append("%s missing %s" % (loc, set(KEYS) - set(have)))
    print("Updated/verified %d/%d files." % (ok, len(files)))
    if missing_loc:
        print("Used English fallback for (no curated translation):", missing_loc)
    if problems:
        print("PROBLEMS:", problems); sys.exit(2)
    print("All language files now contain all 6 keys.")

if __name__ == "__main__":
    main()
