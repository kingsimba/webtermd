package auth

import (
	"crypto"
	"crypto/rsa"
	"crypto/x509"
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

// parseOpenSSHAuthorizedKeys parses OpenSSH-format authorized_keys content.
// Handles lines like: "ssh-rsa AAAAB3NzaC1yc2E... comment"
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
		if parts[0] != "ssh-rsa" {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(parts[1])
		if err != nil {
			continue
		}
		pub, err := parseSSHRSA(raw)
		if err != nil {
			continue
		}
		keys = append(keys, &rsaKey{pub: pub})
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

// PEMToPublicKey converts PEM-encoded PKCS1 RSA public key.
func PEMToPublicKey(pemData []byte) (sshPublicKey, error) {
	block, _ := pem.Decode(pemData)
	if block == nil {
		return nil, x509.ErrUnsupportedAlgorithm
	}
	pub, err := x509.ParsePKCS1PublicKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	return &rsaKey{pub: pub}, nil
}
