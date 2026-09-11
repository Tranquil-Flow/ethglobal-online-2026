"""Pinned MLX-VLM stream assembly; no model imports or execution."""

class StreamAssembly:
    def __init__(self, maximum):
        if type(maximum) is not int or not 1 <= maximum <= 64:
            raise ValueError('INVALID_OUTPUT_BOUND')
        self.maximum = maximum
        self.selected = []
        self.visible = []
        self.text = ''
        self.finish_reason = None

    def consume(self, response):
        if self.finish_reason is not None:
            raise ValueError('EVENT_AFTER_TERMINAL')
        text = response.text
        if not isinstance(text, str):
            raise ValueError('INVALID_TEXT')
        text.encode('utf-8', errors='strict')
        count = response.generation_tokens
        token = response.token
        if hasattr(token, 'item'):
            token = token.item()
        reason = response.finish_reason
        if type(count) is not int or type(token) is not int or not 0 <= token < 2**32:
            raise ValueError('INVALID_NATIVE_TOKEN')
        if reason not in (None, 'stop', 'length'):
            raise ValueError('INVALID_FINISH_REASON')
        emitted = []
        if count == len(self.selected) + 1:
            if count > self.maximum:
                raise ValueError('OUTPUT_TOKEN_LIMIT')
            self.selected.append(token)
            if reason != 'stop':
                self.visible.append(token)
                emitted.append(token)
        elif not (reason == 'length' and count == len(self.selected) and self.selected and token == self.selected[-1]):
            # MLX-VLM's final length chunk repeats the last token and carries
            # only the detokenizer flush; it is not a second generated token.
            raise ValueError('NATIVE_TOKEN_SEQUENCE')
        self.text += text
        if reason is not None:
            if reason == 'length' and len(self.selected) != self.maximum:
                raise ValueError('PREMATURE_LENGTH_TERMINAL')
            self.finish_reason = reason
        return {'text': text, 'tokenIds': emitted}

    def output(self):
        if self.finish_reason is None:
            raise ValueError('MISSING_NATIVE_TERMINAL')
        return {'text': self.text, 'tokenIds': list(self.visible), 'finishReason': self.finish_reason}
