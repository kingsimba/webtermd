package auth

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/x509"
	"encoding/asn1"
	"encoding/base64"
	"encoding/pem"
	"math/big"
	"strings"
)

// sshPublicKey is the interface any parsed SSH public key must satisfy.
type sshPublicKey interface {
	Verify(digest []byte, sig []byte) bool
}

// rsaKey wraps *rsa.PublicKey.
type rsaKey struct {
	pub *rsa.PublicKey
}

func (k *rsaKey) Verify(digest []byte, sig []byte) bool {
	return rsa.VerifyPKCS1v15(k.pub, crypto.SHA256, digest, sig) == nil
}

// ed25519Key wraps ed25519.PublicKey.
type ed25519Key struct {
	pub ed25519.PublicKey
}

func (k *ed25519Key) Verify(digest []byte, sig []byte) bool {
	return ed25519.Verify(k.pub, digest, sig)
}

// ecdsaKey wraps *ecdsa.PublicKey.
type ecdsaKey struct {
	pub *ecdsa.PublicKey
}

func (k *ecdsaKey) Verify(digest []byte, sig []byte) bool {
	return ecdsa.VerifyASN1(k.pub, digest, sig)
}

// parseOpenSSHAuthorizedKeys parses OpenSSH-format authorized_keys content.
func parseOpenSSHAuthorizedKeys(content string) []sshPublicKey {
	var keys []sshPublicKey
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(parts[1])
		if err != nil {
			continue
		}
		var key sshPublicKey
		switch parts[0] {
		case "ssh-rsa":
			pub, err := parseSSHRSA(raw)
			if err == nil {
				key = &rsaKey{pub: pub}
			}
		case "ssh-ed25519":
			pub, err := parseSSHEd25519(raw)
			if err == nil {
				key = &ed25519Key{pub: pub}
			}
		case "ecdsa-sha2-nistp256":
			pub, err := parseSSHECDSA(raw, elliptic.P256())
			if err == nil {
				key = &ecdsaKey{pub: pub}
			}
		case "ecdsa-sha2-nistp384":
			pub, err := parseSSHECDSA(raw, elliptic.P384())
			if err == nil {
				key = &ecdsaKey{pub: pub}
			}
		case "ecdsa-sha2-nistp521":
			pub, err := parseSSHECDSA(raw, elliptic.P521())
			if err == nil {
				key = &ecdsaKey{pub: pub}
			}
		default:
			continue
		}
		if key != nil {
			keys = append(keys, key)
		}
	}
	return keys
}

// parseSSHRSA parses the SSH wire format for an RSA public key:
// [string "ssh-rsa"][mpint e][mpint n]
func parseSSHRSA(data []byte) (*rsa.PublicKey, error) {
	algo, rest, err := readSSHString(data)
	if err != nil {
		return nil, err
	}
	if string(algo) != "ssh-rsa" {
		return nil, x509.ErrUnsupportedAlgorithm
	}
	eBytes, rest, err := readSSHString(rest)
	if err != nil {
		return nil, err
	}
	nBytes, _, err := readSSHString(rest)
	if err != nil {
		return nil, err
	}

	e := 0
	for _, b := range eBytes {
		e = e<<8 | int(b)
	}
	if e < 2 {
		e = 65537
	}

	n := new(big.Int).SetBytes(nBytes)
	return &rsa.PublicKey{N: n, E: e}, nil
}

// parseSSHEd25519 parses SSH wire format: [string "ssh-ed25519"][string key(32 bytes)]
func parseSSHEd25519(data []byte) (ed25519.PublicKey, error) {
	algo, rest, err := readSSHString(data)
	if err != nil {
		return nil, err
	}
	if string(algo) != "ssh-ed25519" {
		return nil, x509.ErrUnsupportedAlgorithm
	}
	keyBytes, _, err := readSSHString(rest)
	if err != nil {
		return nil, err
	}
	if len(keyBytes) != ed25519.PublicKeySize {
		return nil, x509.ErrUnsupportedAlgorithm
	}
	return ed25519.PublicKey(keyBytes), nil
}

// parseSSHECDSA parses SSH wire format:
// [string algo][string curve][string point]
func parseSSHECDSA(data []byte, curve elliptic.Curve) (*ecdsa.PublicKey, error) {
	algo, rest, err := readSSHString(data)
	if err != nil {
		return nil, err
	}
	if string(algo) == "" {
		return nil, x509.ErrUnsupportedAlgorithm
	}
	curveName, rest, err := readSSHString(rest)
	if err != nil {
		return nil, err
	}
	_ = curveName // already matched by caller
	pointBytes, _, err := readSSHString(rest)
	if err != nil {
		return nil, err
	}
	x, y := elliptic.Unmarshal(curve, pointBytes)
	if x == nil {
		return nil, x509.ErrUnsupportedAlgorithm
	}
	return &ecdsa.PublicKey{Curve: curve, X: x, Y: y}, nil
}

func readSSHString(data []byte) ([]byte, []byte, error) {
	if len(data) < 4 {
		return nil, nil, x509.ErrUnsupportedAlgorithm
	}
	length := int(uint32(data[0])<<24 | uint32(data[1])<<16 | uint32(data[2])<<8 | uint32(data[3]))
	if len(data) < 4+length {
		return nil, nil, x509.ErrUnsupportedAlgorithm
	}
	return data[4 : 4+length], data[4+length:], nil
}

// PEMToPublicKey converts a PEM-encoded public key (PKCS1 RSA, PKIX, or PKCS8).
func PEMToPublicKey(pemData []byte) (sshPublicKey, error) {
	block, _ := pem.Decode(pemData)
	if block == nil {
		return nil, x509.ErrUnsupportedAlgorithm
	}

	// Try PKCS1 (RSA only).
	if pub, err := x509.ParsePKCS1PublicKey(block.Bytes); err == nil {
		return &rsaKey{pub: pub}, nil
	}

	// Try PKIX (RSA, ECDSA, Ed25519).
	if pub, err := x509.ParsePKIXPublicKey(block.Bytes); err == nil {
		return wrapPublicKey(pub)
	}

	return nil, x509.ErrUnsupportedAlgorithm
}

func wrapPublicKey(pub any) (sshPublicKey, error) {
	switch k := pub.(type) {
	case *rsa.PublicKey:
		return &rsaKey{pub: k}, nil
	case ed25519.PublicKey:
		return &ed25519Key{pub: k}, nil
	case *ecdsa.PublicKey:
		return &ecdsaKey{pub: k}, nil
	default:
		return nil, x509.ErrUnsupportedAlgorithm
	}
}

// ecdsaSignature is an ASN.1 structure for ECDSA signatures for testing.
type ecdsaSignature struct {
	R, S *big.Int
}

// marshalECDSASig encodes r,s as ASN.1 DER (for testing).
func marshalECDSASig(r, s *big.Int) []byte {
	sig, _ := asn1.Marshal(ecdsaSignature{R: r, S: s})
	return sig
}
