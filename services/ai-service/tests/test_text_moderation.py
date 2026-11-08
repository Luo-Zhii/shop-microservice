from ai_service.moderation import moderate
from ai_service.text import normalize, strip_accents


def test_strip_accents_vietnamese():
    assert strip_accents("Áo thun Đỏ đẹp") == "Ao thun Do dep"
    assert normalize("  Quần JEAN, ống-đứng!! ") == "quan jean ong dung"


def test_clean_review_allowed():
    r = moderate("Áo đẹp, vải mát, giao hàng nhanh. Sẽ ủng hộ shop lần sau!")
    assert r["allowed"] and r["labels"] == [] and r["score"] == 0


def test_profanity_with_and_without_accents():
    assert "profanity" in moderate("Shop làm ăn như cái lồn")["labels"]
    assert "profanity" in moderate("dit me shop lua dao")["labels"]
    assert "profanity" in moderate("đ.i.t m.e")["labels"]
    assert not moderate("profanity", None)["labels"]


def test_no_false_positive_on_common_words():
    # "lớn", "các", "ngủ", "buổi", "đeo" bỏ dấu trùng từ tục — không được gắn cờ
    r = moderate("Các bạn mua size lớn nhé, buổi tối đeo tai nghe ngủ rất êm")
    assert r["allowed"] and "profanity" not in r["labels"]


def test_spam_link_phone_caps():
    r = moderate("SALE SỐC GIÁ RẺ VÔ ĐỊCH LIÊN HỆ NGAY 0912 345 678 hoặc vào bit.ly/abc ib zalo")
    assert {"spam_link", "phone_number", "all_caps", "offsite_trade"} <= set(r["labels"])
    assert not r["allowed"] and r["score"] > 0.8


def test_repetition():
    assert "repetition" in moderate("mua đi mua đi mua đi mua đi mua đi")["labels"]
