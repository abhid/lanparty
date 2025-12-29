package httpserver

import (
	"bytes"
	"image"
	"image/jpeg"
	"os"

	// decoders
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"

	"golang.org/x/image/draw"
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


