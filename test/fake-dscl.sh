#!/bin/bash
# Fake `dscl .` for tests: fails if the password appears in argv; checks the stdin command.
for a in "$@"; do [[ "$a" == *"pa ss"* || "$a" == *hunter* ]] && { echo "argv leak"; exit 3; }; done
read -r line; read -r q
[ "$q" = quit ] || { echo "no quit"; exit 4; }
if [ "$line" = 'authonly alice pa\ ss\"w\\rd' ]; then exit 0; fi
echo "authonly: DS Error: -14090 (eDSAuthFailed)"; exit 0
