import unittest
from types import SimpleNamespace
from codec import StreamAssembly

def chunk(text, token, count, reason=None):
    return SimpleNamespace(text=text, token=token, generation_tokens=count, finish_reason=reason)

class CodecTests(unittest.TestCase):
    def test_length_terminal_flush_does_not_duplicate_last_token(self):
        stream = StreamAssembly(2)
        self.assertEqual(stream.consume(chunk('café', 10, 1))['tokenIds'], [10])
        self.assertEqual(stream.consume(chunk('', 11, 2))['tokenIds'], [11])
        self.assertEqual(stream.consume(chunk(' 🌙', 11, 2, 'length'))['tokenIds'], [])
        self.assertEqual(stream.output(), {'text': 'café 🌙', 'tokenIds': [10, 11], 'finishReason': 'length'})
        self.assertEqual(stream.selected, [10, 11])

    def test_eos_is_selected_but_not_visible(self):
        stream = StreamAssembly(8)
        stream.consume(chunk('ok', 100, 1))
        self.assertEqual(stream.consume(chunk('', 999, 2, 'stop'))['tokenIds'], [])
        self.assertEqual(stream.selected, [100, 999])
        self.assertEqual(stream.output()['tokenIds'], [100])

    def test_invalid_sequence_and_missing_terminal_reject(self):
        for response in [chunk('x', -1, 1), chunk('x', 1, 2), chunk('x', 1, 1, 'invented')]:
            with self.assertRaises(ValueError): StreamAssembly(2).consume(response)
        with self.assertRaises(ValueError): StreamAssembly(2).output()
        with self.assertRaises(ValueError): StreamAssembly(2).consume(chunk('x', 1, 1, 'length'))
        stream = StreamAssembly(1); stream.consume(chunk('', 9, 1, 'stop'))
        with self.assertRaises(ValueError): stream.consume(chunk('x', 1, 2))

class DiagnosticTests(unittest.TestCase):
    def test_private_exception_payload_is_not_in_diagnostics(self):
        import json
        from worker import safe_diagnostic
        try: raise ValueError('PRIVATE-CANARY-NEVER-LOGGED')
        except ValueError as exc: result=safe_diagnostic(exc)
        self.assertNotIn('PRIVATE-CANARY',json.dumps(result))
        self.assertEqual(result['exceptionType'],'ValueError')
        self.assertFalse(result['weightsLoadCompleted'])

if __name__ == '__main__': unittest.main()
