package httpapi

const minimumPasswordLength = 6

func hasMinimumPasswordLength(password string) bool {
	return len(password) >= minimumPasswordLength
}
