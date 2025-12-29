package httpserver

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"strings"

	// decoders
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"

	"golang.org/x/image/draw"
	"golang.org/x/image/font"
	"golang.org/x/image/font/basicfont"
	"golang.org/x/image/math/fixed"
	_ "golang.org/x/image/webp"
)

func makeThumb(absPath string, max int) ([]byte, error) {
	f, err := os.Open(absPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	src, _, err := image.Decode(f)
	if err != nil {
		return nil, err
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return nil, os.ErrInvalid
	}
	if max <= 0 {
		max = 256
	}

	nw, nh := w, h
	if w > h {
		if w > max {
			nw = max
			nh = int(float64(h) * (float64(max) / float64(w)))
		}
	} else {
		if h > max {
			nh = max
			nw = int(float64(w) * (float64(max) / float64(h)))
		}
	}
	if nw < 1 {
		nw = 1
	}
	if nh < 1 {
		nh = 1
	}

	dst := image.NewRGBA(image.Rect(0, 0, nw, nh))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, b, draw.Over, nil)

	var out bytes.Buffer
	enc := jpeg.Options{Quality: 82}
	if err := jpeg.Encode(&out, dst, &enc); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func makeTextThumb(absPath string, max int) ([]byte, error) {
	if max <= 0 {
		max = 256
	}
	// Keep it reasonable.
	if max < 64 {
		max = 64
	}
	if max > 1024 {
		max = 1024
	}
	b, err := os.ReadFile(absPath)
	if err != nil {
		return nil, err
	}
	if len(b) > 16*1024 {
		b = b[:16*1024]
	}
	s := strings.ReplaceAll(string(b), "\r\n", "\n")
	lines := strings.Split(s, "\n")
	if len(lines) > 16 {
		lines = lines[:16]
	}
	for i := range lines {
		lines[i] = strings.TrimRight(lines[i], "\r\t ")
		if len(lines[i]) > 120 {
			lines[i] = lines[i][:120] + "…"
		}
	}

	img := image.NewRGBA(image.Rect(0, 0, max, max))
	bg := color.RGBA{R: 0x0b, G: 0x12, B: 0x20, A: 0xff}
	fg := color.RGBA{R: 0xe2, G: 0xe8, B: 0xf0, A: 0xff}
	muted := color.RGBA{R: 0x94, G: 0xa3, B: 0xb8, A: 0xff}
	for y := 0; y < max; y++ {
		for x := 0; x < max; x++ {
			img.Set(x, y, bg)
		}
	}

	face := basicfont.Face7x13
	d := &font.Drawer{
		Dst:  img,
		Src:  image.NewUniform(fg),
		Face: face,
	}

	// Header: filename (basename)
	base := absPath
	if i := strings.LastIndexAny(base, "/\\"); i >= 0 {
		base = base[i+1:]
	}
	if len(base) > 32 {
		base = base[:32] + "…"
	}
	d.Dot = fixed.P(10, 18)
	d.DrawString(base)

	// Body
	d.Src = image.NewUniform(muted)
	y := 38
	for _, ln := range lines {
		if ln == "" {
			y += 12
			continue
		}
		if y > max-10 {
			break
		}
		d.Dot = fixed.P(10, y)
		d.DrawString(ln)
		y += 12
	}

	// Scale down slightly if requested max is large? (keep as-is; already at max).
	var out bytes.Buffer
	enc := jpeg.Options{Quality: 82}
	if err := jpeg.Encode(&out, img, &enc); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}


