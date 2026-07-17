package static

import "embed"

// FS contains the embedded static web assets.
//
//go:embed *
var FS embed.FS
