"""Photos (no EXIF survives) and the moderation workflow."""

import io
import struct
import zlib

import pytest
from PIL import Image

from .test_recordings import make_place, tone, upload


def jpeg_with_gps(size=(800, 600)) -> bytes:
    image = Image.new("RGB", size, (40, 90, 140))
    exif = Image.Exif()
    exif[0x010F] = "SecretCameraMaker"
    gps = exif.get_ifd(0x8825)
    gps[1] = "N"
    gps[2] = (43.0, 15.0, 30.0)
    gps[3] = "W"
    gps[4] = (2.0, 56.0, 0.0)
    out = io.BytesIO()
    image.save(out, "JPEG", exif=exif)
    return out.getvalue()


def huge_png(width: int, height: int) -> bytes:
    """A valid PNG header claiming a size, tiny on disk: a decompression bomb."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"\0" * 64)) + chunk(b"IEND", b"")


def post_photo(browser, place, data, **params):
    return browser.write("POST", f"/api/places/{place}/photos", content=data, params=params)


@pytest.fixture
def author(harness):
    return harness.signed_in("autora")


@pytest.fixture
def place(author):
    return make_place(author)


def test_gps_exif_does_not_survive(author, place):
    original = jpeg_with_gps()
    assert b"SecretCameraMaker" in original
    assert Image.open(io.BytesIO(original)).getexif().get_ifd(0x8825)

    response = post_photo(author, place, original, caption="Fachada", alt="Una fachada azul")
    assert response.status_code == 201, response.text
    photo = response.json()
    assert photo["alt_text"] == "Una fachada azul"
    for size in ("thumb", "medium", "large"):
        served = author.get(f"/api/photos/{photo['id']}/{size}")
        assert served.status_code == 200
        assert served.headers["content-type"] == "image/jpeg"
        assert b"SecretCameraMaker" not in served.content
        image = Image.open(io.BytesIO(served.content))
        assert not image.getexif()
        assert "exif" not in image.info


def test_sizes_are_generated(author, place):
    photo = post_photo(author, place, jpeg_with_gps((3000, 2000))).json()
    thumb = Image.open(io.BytesIO(author.get(f"/api/photos/{photo['id']}/thumb").content))
    assert max(thumb.size) == 400
    medium = Image.open(io.BytesIO(author.get(f"/api/photos/{photo['id']}/medium").content))
    assert max(medium.size) == 960
    large = Image.open(io.BytesIO(author.get(f"/api/photos/{photo['id']}/large").content))
    assert max(large.size) == 2048


def test_png_and_webp_are_accepted(author, place):
    for fmt in ("PNG", "WEBP"):
        out = io.BytesIO()
        Image.new("RGBA", (64, 64), (1, 2, 3, 128)).save(out, fmt)
        assert post_photo(author, place, out.getvalue()).status_code == 201


def test_a_fake_image_is_refused(author, place):
    response = post_photo(author, place, b"<svg onload=alert(1)>")
    assert response.status_code == 415
    assert response.json()["detail"] == {"code": "not_an_image"}


def test_a_gif_is_refused(author, place):
    out = io.BytesIO()
    Image.new("P", (10, 10)).save(out, "GIF")
    assert post_photo(author, place, out.getvalue()).status_code == 415


def test_a_decompression_bomb_is_refused_before_decoding(author, place):
    response = post_photo(author, place, huge_png(30000, 30000))
    assert response.status_code == 413
    assert response.json()["detail"] == {"code": "image_too_large"}


def test_a_file_over_the_size_limit_is_refused(author, place, secure_settings):
    secure_settings.photo_max_bytes = 1000
    assert post_photo(author, place, b"x" * 2000).status_code == 413


def test_photo_limit_per_person_and_place(author, place, secure_settings):
    secure_settings.photos_per_person_per_place = 2
    assert post_photo(author, place, jpeg_with_gps()).status_code == 201
    assert post_photo(author, place, jpeg_with_gps()).status_code == 201
    third = post_photo(author, place, jpeg_with_gps())
    assert third.status_code == 409
    assert third.json()["detail"] == {"code": "photo_limit"}


def test_only_uploader_or_admin_removes_a_photo(author, place, harness):
    photo = post_photo(author, place, jpeg_with_gps()).json()
    other = harness.signed_in("otra")
    assert other.write("POST", f"/api/photos/{photo['id']}/remove").status_code == 403
    assert author.write("POST", f"/api/photos/{photo['id']}/remove").status_code == 204
    assert other.get(f"/api/places/{place}/photos").json() == []
    assert other.get(f"/api/photos/{photo['id']}/thumb").status_code == 404


def test_photos_need_a_session(harness, author, place):
    photo = post_photo(author, place, jpeg_with_gps()).json()
    assert harness.browser().get(f"/api/photos/{photo['id']}/thumb").status_code == 401


# --- Moderation -----------------------------------------------------------------


def published(author, place, tmp_path):
    return upload(author, place, tone(tmp_path / "t.wav", 1).read_bytes())


def test_report_remove_restore_cycle(author, place, harness, tmp_path):
    recording = published(author, place, tmp_path)
    admin = harness.signed_in("raiz", admin=True)
    reader = harness.signed_in("lectora")

    # Someone reports it, and the administrator sees it, with the reason.
    report = reader.write("POST", f"/api/recordings/{recording['id']}/report", json={"reason": "Ruido ajeno"})
    assert report.status_code == 201
    content = admin.get("/api/admin/content").json()
    row = content["recordings"][0]
    assert row["id"] == recording["id"]
    assert row["report_count"] == 1
    assert row["reports"][0]["reason"] == "Ruido ajeno"

    # Removed: gone for everyone else, from every way of finding it.
    removed = admin.write("POST", f"/api/admin/recordings/{recording['id']}/remove", json={"reason": "Motivo interno"})
    assert removed.status_code == 200
    assert removed.json()["removed_reason"] == "Motivo interno"
    gone = reader.get(f"/api/recordings/{recording['id']}")
    assert gone.status_code == 410
    assert "Motivo interno" not in gone.text
    assert reader.get(f"/api/recordings/{recording['id']}/audio").status_code == 410
    assert reader.get(f"/api/places/{place}/recordings").json()["items"] == []
    assert reader.get(f"/api/places/{place}").json()["recording_count"] == 0
    # The author sees "no longer available" too.
    assert author.get(f"/api/recordings/{recording['id']}").status_code == 410

    # The files were kept: restoring brings it back as it was.
    restored = admin.write("POST", f"/api/admin/recordings/{recording['id']}/restore")
    assert restored.json()["status"] == "ready"
    assert reader.get(f"/api/recordings/{recording['id']}").status_code == 200
    assert reader.get(f"/api/recordings/{recording['id']}/audio").status_code == 200
    assert reader.get(f"/api/places/{place}").json()["recording_count"] == 1


def test_removal_reason_is_only_for_admins(author, place, harness, tmp_path):
    recording = published(author, place, tmp_path)
    admin = harness.signed_in("raiz", admin=True)
    admin.write("POST", f"/api/admin/recordings/{recording['id']}/remove", json={"reason": "Motivo interno"})
    assert admin.get(f"/api/recordings/{recording['id']}").json()["removed_reason"] == "Motivo interno"


def test_non_admins_get_403_on_moderation(author, place, tmp_path):
    recording = published(author, place, tmp_path)
    for path in ("remove", "restore", "resolve-reports"):
        response = author.write("POST", f"/api/admin/recordings/{recording['id']}/{path}", json={"reason": "x"})
        assert response.status_code == 403
    assert author.write("POST", f"/api/admin/places/{place}/remove", json={"reason": "x"}).status_code == 403


def test_a_removed_place_disappears_from_the_map_and_list(author, place, harness):
    admin = harness.signed_in("raiz", admin=True)
    assert admin.write("POST", f"/api/admin/places/{place}/remove", json={"reason": "duplicado"}).status_code == 200
    reader = harness.signed_in("lectora")
    assert reader.get("/api/places/list").json()["total"] == 0
    assert reader.get("/api/places", params={"bbox": "-180,-90,180,90"}).json()["features"] == []
    assert reader.get(f"/api/places/{place}").status_code == 404
    assert admin.write("POST", f"/api/admin/places/{place}/restore").status_code == 200
    assert reader.get("/api/places/list").json()["total"] == 1


def test_resolving_reports_clears_them_without_removing(author, place, harness, tmp_path):
    recording = published(author, place, tmp_path)
    reader = harness.signed_in("lectora")
    admin = harness.signed_in("raiz", admin=True)
    reader.write("POST", f"/api/recordings/{recording['id']}/report", json={"reason": "No es para tanto"})
    assert admin.write("POST", f"/api/admin/recordings/{recording['id']}/resolve-reports").status_code == 204
    assert admin.get("/api/admin/content").json()["recordings"][0]["report_count"] == 0
    assert reader.get(f"/api/recordings/{recording['id']}").status_code == 200
