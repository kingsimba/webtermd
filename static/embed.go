package static

import "embed"

// FS contains the embedded static web assets.
//
//go:embed index.html
var FS embed.FS
