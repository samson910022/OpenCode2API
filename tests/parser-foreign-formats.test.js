import { describe, expect, test } from '@jest/globals';
import { buildExternalToolRegistry } from '../src/tool-runtime/registry.js';
import {
    parseExternalToolCallsFromText,
    parseExternalToolCallsFromJoinedText,
    mergeToolCallArtifacts,
    assertToolCallArtifactIntegrity,
    stripExternalToolCallMarkupFromJoinedText,
    stripFunctionCallMarkup,
    createToolCallFilter,
    createExternalToolCallStreamParser
} from '../src/tool-runtime/parser.js';

/**
 * Every fixture in this file is verbatim output captured from OpenCode free models
 * (deepseek-v4-flash-free / big-pickle) running through the proxy-bridge tool mode.
 * These models ignore the instructed <function_calls> contract and emit their own
 * native or invented markup, which used to be dropped entirely.
 */

const registry = buildExternalToolRegistry([
    {
        type: 'function',
        function: {
            name: 'bash',
            description: 'Run a shell command',
            parameters: {
                type: 'object',
                properties: { command: { type: 'string' }, description: { type: 'string' } },
                required: ['command']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read',
            description: 'Read a file',
            parameters: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] }
        }
    }
]);

const firstCall = (calls) => {
    expect(calls.length).toBeGreaterThan(0);
    return { name: calls[0].function.name, args: JSON.parse(calls[0].function.arguments) };
};

describe('canonical <function_calls> format still works', () => {
    test('parses single call', () => {
        const text = '<function_calls>{"name":"external__bash","arguments":{"command":"ls -la"}}</function_calls>';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls -la' });
    });

    test('parses array payload', () => {
        const text = '<function_calls>[{"name":"external__bash","arguments":{"command":"pwd"}},{"name":"external__read","arguments":{"file":"a.txt"}}]</function_calls>';
        const calls = parseExternalToolCallsFromText(registry, text);
        expect(calls.map((c) => c.function.name)).toEqual(['bash', 'read']);
    });

    test('strips canonical markup', () => {
        const text = 'before <function_calls>{"name":"external__bash","arguments":{}}</function_calls> after';
        expect(stripFunctionCallMarkup(text)).toBe('before  after');
    });
});

describe('DSML format (DeepSeek native)', () => {
    const dsml = [
        '<｜｜DSML｜｜tool_calls>',
        '<｜｜DSML｜｜invoke name="external__bash">',
        '<｜｜DSML｜｜parameter name="command" string="true">ls -la</｜｜DSML｜｜parameter>',
        '</｜｜DSML｜｜invoke>',
        '</｜｜DSML｜｜tool_calls>'
    ].join('\n');

    test('parses single-parameter invoke', () => {
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, dsml));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls -la' });
    });

    test('parses multi-parameter invoke with un-namespaced tool name', () => {
        const text = [
            '<｜｜DSML｜｜tool_calls>',
            '<｜｜DSML｜｜invoke name="bash">',
            '<｜｜DSML｜｜parameter name="command" string="true">cat sample.txt</｜｜DSML｜｜parameter>',
            '<｜｜DSML｜｜parameter name="description" string="true">Read sample.txt contents</｜｜DSML｜｜parameter>',
            '</｜｜DSML｜｜invoke>',
            '</｜｜DSML｜｜tool_calls>'
        ].join('\n');
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'cat sample.txt', description: 'Read sample.txt contents' });
    });

    test('parses multiple invokes in one block', () => {
        const text = [
            '<｜｜DSML｜｜tool_calls>',
            '<｜｜DSML｜｜invoke name="bash">',
            '<｜｜DSML｜｜parameter name="command" string="true">pwd</｜｜DSML｜｜parameter>',
            '</｜｜DSML｜｜invoke>',
            '<｜｜DSML｜｜invoke name="read">',
            '<｜｜DSML｜｜parameter name="file" string="true">a.txt</｜｜DSML｜｜parameter>',
            '</｜｜DSML｜｜invoke>',
            '</｜｜DSML｜｜tool_calls>'
        ].join('\n');
        const calls = parseExternalToolCallsFromText(registry, text);
        expect(calls.map((c) => c.function.name)).toEqual(['bash', 'read']);
    });

    test('preserves multi-line parameter values verbatim', () => {
        const text = [
            '<｜｜DSML｜｜tool_calls>',
            '<｜｜DSML｜｜invoke name="bash">',
            '<｜｜DSML｜｜parameter name="command" string="true">line1',
            'line2  ',
            '  line3</｜｜DSML｜｜parameter>',
            '</｜｜DSML｜｜invoke>',
            '</｜｜DSML｜｜tool_calls>'
        ].join('\n');
        const { args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(args.command).toBe('line1\nline2  \n  line3');
    });

    test('coerces non-string parameters when string flag is absent', () => {
        const text = [
            '<｜｜DSML｜｜tool_calls>',
            '<｜｜DSML｜｜invoke name="bash">',
            '<｜｜DSML｜｜parameter name="command" string="true">ls</｜｜DSML｜｜parameter>',
            '<｜｜DSML｜｜parameter name="timeout">30</｜｜DSML｜｜parameter>',
            '</｜｜DSML｜｜invoke>',
            '</｜｜DSML｜｜tool_calls>'
        ].join('\n');
        const { args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(args.timeout).toBe(30);
    });

    test('strips DSML markup from text without a registry', () => {
        expect(stripFunctionCallMarkup(`answer\n${dsml}`)).toBe('answer');
    });

    test('parses generic invoke/parameter markup without DSML delimiters', () => {
        const text = [
            '<invoke name="bash">',
            '<parameter name="command">echo hi</parameter>',
            '</invoke>'
        ].join('\n');
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'echo hi' });
    });
});

describe('<tool_call> JSON wrapper format', () => {
    test('parses name/arguments payload', () => {
        const text = '<tool_call>\n{"name":"external__bash","arguments":{"command":"ls"}}\n</tool_call>';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls' });
    });

    test('parses OpenAI-shaped function payload', () => {
        const text = '<tool_call>{"function":{"name":"read","arguments":{"file":"x.txt"}}}</tool_call>';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('read');
        expect(args).toEqual({ file: 'x.txt' });
    });

    test('parses stringified arguments', () => {
        const text = '<tool_call>{"name":"bash","arguments":"{\\"command\\":\\"pwd\\"}"}</tool_call>';
        const { args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(args).toEqual({ command: 'pwd' });
    });

    test('handles tool_calls alias wrapper', () => {
        const text = '<tool_calls>{"name":"bash","arguments":{"command":"id"}}</tool_calls>';
        const { name } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
    });

    test('strips wrapper markup without a registry', () => {
        const text = 'ok\n<tool_call>{"name":"bash","arguments":{}}</tool_call>';
        expect(stripFunctionCallMarkup(text)).toBe('ok');
    });
});

describe('tag-named formats', () => {
    test('parses self-closing tag with JSON attribute', () => {
        const text = `<external__bash arguments='{"command":"ls -la"}' name="external__bash"/>`;
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls -la' });
    });

    // Observed live: the JSON attribute value carries no surrounding quotes.
    test('parses unquoted JSON attribute', () => {
        const text = '<external__bash name="external__bash" arguments={"command":"ls"} />';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls' });
    });

    test('parses unquoted JSON attribute whose value contains a redirect', () => {
        const text = '<external__bash arguments={"command":"ls > out.txt"} />';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls > out.txt' });
    });

    test('parses quoted JSON attribute whose value contains a redirect', () => {
        const text = `<external__bash arguments='{"command":"ls > out.txt"}' />`;
        const { args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(args).toEqual({ command: 'ls > out.txt' });
    });

    test('strips an unquoted JSON attribute tag from visible text', () => {
        const text = 'before <external__bash arguments={"command":"ls"} /> after';
        expect(stripFunctionCallMarkup(text, true, { registry })).toBe('before  after');
    });

    test('parses tag with quoted description and JSON body', () => {
        const text = '<external__bash "Run a shell command">\n{"command":"ls -la"}';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls -la' });
    });

    test('parses tag wrapping a <parameters> JSON block inside prose', () => {
        const text = [
            '<details>',
            '<summary>Running ls to list files</summary>',
            '<external__bash>',
            '<parameters>',
            '{',
            '  "command": "ls -la"',
            '}',
            '</parameters>',
            '</external__bash>',
            '</details>'
        ].join('\n');
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls -la' });
    });

    test('parses closed tag with direct JSON body', () => {
        const text = '<external__read>{"file":"notes.md"}</external__read>';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('read');
        expect(args).toEqual({ file: 'notes.md' });
    });

    test('ignores tags that are not registered tools', () => {
        const text = '<summary>{"command":"rm -rf /"}</summary>';
        expect(parseExternalToolCallsFromText(registry, text)).toEqual([]);
    });

    test('leaves unrelated html untouched when stripping', () => {
        const text = 'see <details>more</details> here';
        expect(stripFunctionCallMarkup(text, true, { registry })).toBe('see <details>more</details> here');
    });
});

/**
 * Cline/Roo-style markup, where each argument is its own XML child element. Captured live
 * from deepseek-v4-flash-free: `<read>\n<path>a.txt</path>\n</read>`. The tag was matched
 * but the children were discarded, producing a call with empty arguments that then failed
 * schema validation for any tool with required fields.
 */
describe('XML child element arguments', () => {
    const xmlRegistry = buildExternalToolRegistry([
        {
            type: 'function',
            name: 'read',
            description: 'Read a file',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    offset: { type: 'number' },
                    recursive: { type: 'boolean' }
                },
                required: ['path']
            }
        },
        {
            type: 'function',
            name: 'bash',
            description: 'Run a command',
            parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
        }
    ]);

    test('parses a single child element on its own line', () => {
        const text = '<read>\n<path>a.txt</path>\n</read>';
        const { name, args } = firstCall(parseExternalToolCallsFromText(xmlRegistry, text));
        expect(name).toBe('read');
        expect(args).toEqual({ path: 'a.txt' });
    });

    test('parses multiple children and coerces by declared schema type', () => {
        const text = '<read><path>a.txt</path><offset>10</offset><recursive>true</recursive></read>';
        const { args } = firstCall(parseExternalToolCallsFromText(xmlRegistry, text));
        expect(args).toEqual({ path: 'a.txt', offset: 10, recursive: true });
    });

    test('keeps a numeric-looking string argument as a string', () => {
        const text = '<read><path>123.txt</path></read>';
        const { args } = firstCall(parseExternalToolCallsFromText(xmlRegistry, text));
        expect(args).toEqual({ path: '123.txt' });
        expect(typeof args.path).toBe('string');
    });

    test('accepts the namespaced tag name', () => {
        const text = '<external__read><path>/tmp/x.log</path></external__read>';
        const { name, args } = firstCall(parseExternalToolCallsFromText(xmlRegistry, text));
        expect(name).toBe('read');
        expect(args).toEqual({ path: '/tmp/x.log' });
    });

    test('preserves a redirect inside a child element value', () => {
        const text = '<bash><command>ls > out.txt</command></bash>';
        const { args } = firstCall(parseExternalToolCallsFromText(xmlRegistry, text));
        expect(args).toEqual({ command: 'ls > out.txt' });
    });

    test('ignores child elements that are not declared in the schema', () => {
        const text = '<read><path>a.txt</path><rm_rf>/</rm_rf></read>';
        const { args } = firstCall(parseExternalToolCallsFromText(xmlRegistry, text));
        expect(args).toEqual({ path: 'a.txt' });
    });

    test('strips the markup from visible text', () => {
        const text = 'Let me look: <read>\n<path>a.txt</path>\n</read>';
        expect(stripFunctionCallMarkup(text, true, { registry: xmlRegistry })).toBe('Let me look:');
    });

    test('does not call a named tag whose body is neither JSON nor declared XML', () => {
        const text = '<read>just some prose</read>';
        expect(parseExternalToolCallsFromText(xmlRegistry, text)).toEqual([]);
    });
});

describe('bare JSON format', () => {
    test('parses whole-body JSON object', () => {
        const text = '{"name":"external__bash","arguments":{"command":"ls"}}';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls' });
    });

    test('parses whole-body JSON wrapped in a fenced code block', () => {
        const text = '```json\n{"name":"bash","arguments":{"command":"ls"}}\n```';
        const { name } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
    });

    test('parses whole-body tool_calls array', () => {
        const text = '{"tool_calls":[{"name":"bash","arguments":{"command":"pwd"}}]}';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'pwd' });
    });

    test('ignores JSON embedded in prose', () => {
        const text = 'Here is an example payload: {"name":"bash","arguments":{"command":"ls"}} — note the shape.';
        expect(parseExternalToolCallsFromText(registry, text)).toEqual([]);
    });

    test('ignores JSON naming an unregistered tool', () => {
        const text = '{"name":"launch_missiles","arguments":{}}';
        expect(parseExternalToolCallsFromText(registry, text)).toEqual([]);
    });

    test('ignores JSON without a name field', () => {
        expect(parseExternalToolCallsFromText(registry, '{"command":"ls"}')).toEqual([]);
    });
});

describe('no false positives on ordinary output', () => {
    test.each([
        ['plain prose', 'B-trees keep all leaves at the same depth.'],
        ['prose naming a tool', 'You can use bash to list files.'],
        ['markdown code block', '```js\nconst name = "bash";\n```'],
        ['angle brackets in math', 'if a < b and b > c then swap'],
        ['empty string', ''],
        ['html-ish prose', 'Use <b>bold</b> for emphasis.']
    ])('%s yields no tool calls', (_label, text) => {
        expect(parseExternalToolCallsFromText(registry, text)).toEqual([]);
    });

    test.each([
        ['plain prose', 'B-trees keep all leaves at the same depth.'],
        ['markdown code block', '```js\nconst name = "bash";\n```'],
        ['html-ish prose', 'Use <b>bold</b> for emphasis.']
    ])('%s survives stripping unchanged', (_label, text) => {
        expect(stripFunctionCallMarkup(text, false, { registry })).toBe(text);
    });

    test('empty registry never yields tool calls', () => {
        const dsml = '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="bash">\n<｜｜DSML｜｜parameter name="command" string="true">ls</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>';
        expect(parseExternalToolCallsFromText([], dsml)).toEqual([]);
    });
});

describe('streaming: foreign markup is withheld from text deltas', () => {
    const runFilter = (chunks) => {
        const filter = createToolCallFilter({ disableTools: true, registry });
        return chunks.map((chunk) => filter(chunk)).join('') + filter.flush();
    };

    test('suppresses DSML markup split across chunks', () => {
        const chunks = [
            'Let me look.\n',
            '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="bash">\n',
            '<｜｜DSML｜｜parameter name="command" string="true">ls -la</｜｜DSML｜｜parameter>\n',
            '</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>'
        ];
        expect(runFilter(chunks)).toBe('Let me look.\n');
    });

    test('suppresses canonical markup split mid-tag', () => {
        const chunks = ['keep ', '<function_c', 'alls>{"name":"bash","arguments":{}}</function_calls>', ' tail'];
        expect(runFilter(chunks)).toBe('keep  tail');
    });

    test('suppresses <tool_call> wrapper', () => {
        const chunks = ['pre ', '<tool_call>{"name":"bash",', '"arguments":{"command":"ls"}}</tool_call>'];
        expect(runFilter(chunks)).toBe('pre ');
    });

    test('suppresses whole-body bare JSON', () => {
        expect(runFilter(['{"name":"bash",', '"arguments":{"command":"ls"}}'])).toBe('');
    });

    test('passes ordinary text through unchanged', () => {
        const chunks = ['Hello ', 'world. ', 'a < b > c'];
        expect(runFilter(chunks)).toBe('Hello world. a < b > c');
    });

    test('releases buffered text that turns out not to be markup', () => {
        expect(runFilter(['a < b', ' and c > d'])).toBe('a < b and c > d');
    });

    test('flush releases an unterminated partial tag', () => {
        expect(runFilter(['done <tool_c'])).toBe('done <tool_c');
    });

    // Observed live: the opener lands in one channel and the closer in the other, so a
    // filter can receive a close tag it never saw an opener for. It must not leak.
    // Surrounding whitespace is the model's own text and is preserved.
    test('suppresses an orphaned canonical close tag', () => {
        expect(runFilter(["I'll list the files.\n\n", '</function_calls>'])).toBe("I'll list the files.\n\n");
    });

    test('suppresses an orphaned close tag split across chunks', () => {
        expect(runFilter(['text ', '</function_', 'calls>'])).toBe('text ');
    });

    test.each([
        ['</tool_call>'],
        ['</tool_calls>'],
        ['</invoke>'],
        ['</\uFF5C\uFF5CDSML\uFF5C\uFF5Ctool_calls>']
    ])('suppresses orphaned close tag %s', (tag) => {
        expect(runFilter(['ok ', tag])).toBe('ok ');
    });

    test('keeps ordinary closing html tags', () => {
        expect(runFilter(['see <b>bold</b> here'])).toBe('see <b>bold</b> here');
    });
});

describe('streaming: tool calls are extracted mid-stream', () => {
    const runParser = (chunks) => {
        const parse = createExternalToolCallStreamParser(registry);
        const calls = chunks.flatMap((chunk) => parse(chunk));
        return [...calls, ...parse.flush()];
    };

    test('extracts canonical call split across chunks', () => {
        const calls = runParser(['<function_ca', 'lls>{"name":"bash","argum', 'ents":{"command":"ls"}}</function_calls>']);
        expect(calls).toHaveLength(1);
        expect(calls[0].function.name).toBe('bash');
    });

    test('extracts DSML call split across chunks', () => {
        const calls = runParser([
            '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invo',
            'ke name="bash">\n<｜｜DSML｜｜parameter name="command" string="true">ls -la',
            '</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>'
        ]);
        expect(calls).toHaveLength(1);
        expect(JSON.parse(calls[0].function.arguments)).toEqual({ command: 'ls -la' });
    });

    test('extracts <tool_call> wrapper call', () => {
        const calls = runParser(['<tool_call>{"name":"read","arguments":{"file":"a.txt"}}</tool_call>']);
        expect(calls).toHaveLength(1);
        expect(calls[0].function.name).toBe('read');
    });

    test('extracts whole-body bare JSON on flush', () => {
        const calls = runParser(['{"name":"bash","arguments":{"command":"ls"}}']);
        expect(calls).toHaveLength(1);
        expect(calls[0].function.name).toBe('bash');
    });

    test('does not emit duplicates for one call', () => {
        const calls = runParser([
            '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>'
        ]);
        expect(calls).toHaveLength(1);
    });

    test('yields nothing for ordinary prose', () => {
        expect(runParser(['Just ', 'explaining ', 'B-trees.'])).toEqual([]);
    });

    test('assigns distinct ids to repeated calls', () => {
        const calls = runParser([
            '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>',
            '<tool_call>{"name":"bash","arguments":{"command":"pwd"}}</tool_call>'
        ]);
        expect(calls).toHaveLength(2);
        expect(calls[0].id).not.toBe(calls[1].id);
    });

    test.each(['<external__read>', '<function=read>'])('does not flush an empty call for partial tag %s', (partial) => {
        expect(runParser([partial])).toEqual([]);
    });
});

describe('cross-channel blocks', () => {
    // OpenCode streams reasoning and content as separate channels with independent
    // parser buffers. A model that starts a block in one and finishes it in the other
    // leaves neither buffer holding a complete block, so the end-of-stream batch parse
    // has to see the two channels joined.
    test('block split between reasoning and content is found when joined', () => {
        const reasoningPart = 'Thinking about it.\n<function_calls>{"name":"bash",';
        const contentPart = '"arguments":{"command":"ls"}}</function_calls>';

        expect(parseExternalToolCallsFromText(registry, reasoningPart, contentPart)).toEqual([]);

        const joined = parseExternalToolCallsFromText(registry, `${reasoningPart}${contentPart}`);
        expect(joined).toHaveLength(1);
        expect(joined[0].function.name).toBe('bash');
        expect(JSON.parse(joined[0].function.arguments)).toEqual({ command: 'ls' });
    });

    test('joining does not double-count a block wholly inside one channel', () => {
        const content = '<function_calls>{"name":"bash","arguments":{"command":"ls"}}</function_calls>';
        expect(parseExternalToolCallsFromText(registry, `${content}`)).toHaveLength(1);
    });

    test('bare JSON in one channel still parses when that channel is passed alone', () => {
        const calls = parseExternalToolCallsFromText(registry, '{"name":"bash","arguments":{"command":"ls"}}');
        expect(calls).toHaveLength(1);
    });

    test('named tag split between reasoning and content completes in the joined view', () => {
        const calls = parseExternalToolCallsFromJoinedText(
            registry,
            'before <external__read>',
            '{"file":"a.txt"}</external__read> after'
        );
        expect(calls).toHaveLength(1);
        expect(calls[0].function.name).toBe('read');
        expect(JSON.parse(calls[0].function.arguments)).toEqual({ file: 'a.txt' });
    });

    test('function-equals tag split between reasoning and content completes in the joined view', () => {
        const calls = parseExternalToolCallsFromJoinedText(
            registry,
            'before <function=read>',
            '<parameter=file>a.txt</parameter></function> after'
        );
        expect(calls).toHaveLength(1);
        expect(calls[0].function.name).toBe('read');
        expect(JSON.parse(calls[0].function.arguments)).toEqual({ file: 'a.txt' });
    });
});

describe('rawCallsFromJsonText JSON scan fallback', () => {
    test('parses nested function_calls wrapper emitted by models echoing the reminder', () => {
        const nested = '<function_calls>\n<function_calls>\n{"name":"external__bash","arguments":{"command":"ls"}}\n</function_calls>';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, nested));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls' });
    });

    test('scan fallback works for JSON prefixed by prose inside the block', () => {
        const text = '<function_calls>calling tool: {"name":"external__bash","arguments":{"command":"pwd"}}</function_calls>';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'pwd' });
    });

    test('clean canonical format still parses correctly after the fallback was added', () => {
        const text = '<function_calls>{"name":"external__bash","arguments":{"command":"echo hi"}}</function_calls>';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'echo hi' });
    });
});

describe('<function=name>/<parameter=key> markup (Qwen/GLM native dialect)', () => {
    test('parses a <tool_call> block with <function=...> and <parameter=...> children', () => {
        const text = '<tool_call>\n<function=bash>\n<parameter=command>ls -la</parameter>\n<parameter=description>list files</parameter>\n</function>\n</tool_call>';
        const { name, args } = firstCall(parseExternalToolCallsFromText(registry, text));
        expect(name).toBe('bash');
        expect(args).toEqual({ command: 'ls -la', description: 'list files' });
    });

    test('normalizes a separator-dropped tool name to the registry name', () => {
        // `web_fetch`-style mismatch: the model writes the name without the underscore.
        const fetchRegistry = buildExternalToolRegistry([
            { type: 'function', function: { name: 'web_fetch', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } }
        ]);
        const text = '<tool_call>\n<function=webfetch>\n<parameter=url>https://example.com</parameter>\n</function>\n</tool_call>';
        const calls = parseExternalToolCallsFromText(fetchRegistry, text);
        expect(calls).toHaveLength(1);
        expect(calls[0].function.name).toBe('web_fetch');
        expect(JSON.parse(calls[0].function.arguments)).toEqual({ url: 'https://example.com' });
    });

    test('strips the <function=...> block from visible text', () => {
        const text = 'Let me run a command.\n<tool_call>\n<function=bash>\n<parameter=command>ls</parameter>\n</function>\n</tool_call>';
        const stripped = stripFunctionCallMarkup(text);
        expect(stripped).not.toContain('<function=');
        expect(stripped).not.toContain('<parameter=');
        expect(stripped).not.toContain('</function>');
        expect(stripped).toContain('Let me run a command');
    });

    test('joined parsing keeps a cross-channel call and per-channel calls', () => {
        const reasoning = '<function_calls>{"name":"bash","arguments":{"command":"ls"';
        const content = '}}</function_calls>';
        const calls = parseExternalToolCallsFromJoinedText(registry, reasoning, content);
        expect(calls).toHaveLength(1);
        expect(JSON.parse(calls[0].function.arguments)).toEqual({ command: 'ls' });
    });

    test('joining does not double-count a complete channel call', () => {
        const content = '<function_calls>{"name":"bash","arguments":{"command":"ls"}}</function_calls>';
        const calls = parseExternalToolCallsFromJoinedText(registry, '', content);
        expect(calls).toHaveLength(1);
    });

    test('merging retains different explicit ids and deduplicates generated artifacts', () => {
        const first = parseExternalToolCallsFromText(registry, '<function_calls>{"id":"call_a","name":"bash","arguments":{"command":"ls"}}</function_calls>');
        const second = parseExternalToolCallsFromText(registry, '<function_calls>{"id":"call_b","name":"bash","arguments":{"command":"ls"}}</function_calls>');
        const generated = parseExternalToolCallsFromText(registry, '<function_calls>{"name":"bash","arguments":{"command":"pwd"}}</function_calls>');
        const merged = mergeToolCallArtifacts(first, second, generated, generated);
        expect(merged.map((call) => call.id)).toEqual(['call_a', 'call_b', expect.any(String)]);
        expect(new Set(merged.map((call) => call.id)).size).toBe(3);
    });

    test('collect and merge retain same-call explicit ids and same-id argument conflicts', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '<function_calls>[{"id":"call_a","name":"read","arguments":{"file":"a.txt"}},{"id":"call_b","name":"read","arguments":{"file":"a.txt"}},{"id":"call_a","name":"read","arguments":{"file":"b.txt"}}]</function_calls>'
        );
        const merged = mergeToolCallArtifacts(calls);
        expect(merged.map((call) => call.id)).toEqual(['call_a', 'call_b', 'call_a']);
        expect(merged.map((call) => JSON.parse(call.function.arguments))).toEqual([
            { file: 'a.txt' },
            { file: 'a.txt' },
            { file: 'b.txt' }
        ]);
        expect(() => assertToolCallArtifactIntegrity(merged, registry, '')).toThrow(/duplicate external tool call id/);
    });

    test('does not deduplicate a generated artifact against an explicit call', () => {
        const explicit = parseExternalToolCallsFromText(registry, '<function_calls>{"id":"call_explicit","name":"read","arguments":{"file":"a.txt"}}</function_calls>');
        const generated = parseExternalToolCallsFromText(registry, '<function_calls>{"name":"read","arguments":{"file":"a.txt"}}</function_calls>');
        expect(mergeToolCallArtifacts(explicit, generated)).toHaveLength(2);
    });

    test('deduplicates explicit ids with canonical argument key order', () => {
        const first = parseExternalToolCallsFromText(registry, '<function_calls>{"id":"same","name":"read","arguments":{"file":"a.txt","offset":1}}</function_calls>');
        const second = parseExternalToolCallsFromText(registry, '<function_calls>{"id":"same","name":"read","arguments":{"offset":1,"file":"a.txt"}}</function_calls>');
        const merged = mergeToolCallArtifacts(first, second);
        expect(merged).toHaveLength(1);
        expect(() => assertToolCallArtifactIntegrity(merged, registry, '')).not.toThrow();
    });

    test('generated artifacts with different arguments receive unique merged ids', () => {
        const first = parseExternalToolCallsFromText(registry, '<function_calls>{"name":"read","arguments":{"file":"a.txt"}}</function_calls>');
        const second = parseExternalToolCallsFromText(registry, '<function_calls>{"name":"read","arguments":{"file":"b.txt"}}</function_calls>');
        const merged = mergeToolCallArtifacts(first, second);
        expect(merged).toHaveLength(2);
        expect(new Set(merged.map((call) => call.id)).size).toBe(2);
    });

    test('retains different explicit ids with the same arguments', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '<function_calls>[{"id":"call_a","name":"read","arguments":{"file":"a.txt"}},{"id":"call_b","name":"read","arguments":{"file":"a.txt"}}]</function_calls>'
        );
        const merged = mergeToolCallArtifacts(calls);
        expect(merged.map((call) => call.id)).toEqual(['call_a', 'call_b']);
    });

    test('retains generated parallel calls with identical arguments', () => {
        const calls = parseExternalToolCallsFromText(
            registry,
            '<function_calls>[{"name":"read","arguments":{"file":"a.txt"}},{"name":"read","arguments":{"file":"a.txt"}}]</function_calls>'
        );
        expect(calls).toHaveLength(2);
        const merged = mergeToolCallArtifacts(calls);
        expect(merged).toHaveLength(2);
        expect(new Set(merged.map((call) => call.id)).size).toBe(2);
    });

    test('deduplicates a repeated generated artifact to a single call', () => {
        const single = parseExternalToolCallsFromText(registry, '<function_calls>{"name":"read","arguments":{"file":"a.txt"}}</function_calls>');
        const merged = mergeToolCallArtifacts(single, single);
        expect(merged).toHaveLength(1);
    });
});

describe('malformed envelope gate', () => {
    const gate = (text) => {
        try {
            assertToolCallArtifactIntegrity(
                parseExternalToolCallsFromJoinedText(registry, '', text),
                registry,
                text
            );
            return null;
        } catch (error) {
            return error.code;
        }
    };

    test.each([
        ['an unclosed DSML container', '<tool_calls>{"name":"bash","arguments":{"command":"ls"}}'],
        [
            'an unclosed DSML marker container',
            '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="bash"><｜｜DSML｜｜parameter name="command" string="true">ls</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>'
        ],
        ['an unclosed <tool_call> wrapper', '<tool_call>{"name":"bash","arguments":{"command":"ls"}}'],
        [
            'a bare array with an invalid member',
            '[{"name":"bash","arguments":{"command":"ls"}},{"arguments":{"command":"pwd"}}]'
        ],
        [
            'a bare array with an unknown member',
            '[{"name":"bash","arguments":{"command":"ls"}},{"name":"missing","arguments":{}}]'
        ],
        ['a bare array with a trailing member', '[{"name":"bash","arguments":{"command":"ls"}},"junk"]'],
        [
            'a valid canonical block followed by an unclosed DSML container',
            '<function_calls>{"name":"bash","arguments":{"command":"ls"}}</function_calls><tool_calls>{"name":"bash"'
        ],
        [
            'a valid DSML container followed by an unclosed <tool_call> wrapper',
            '<tool_calls><invoke name="bash"><parameter name="command" string="true">ls</parameter></invoke></tool_calls><tool_call>{"name":"bash"'
        ],
        [
            'a valid bare call followed by a bare array with a bad member',
            '{"name":"bash","arguments":{"command":"ls"}}\n[{"name":"bash","arguments":{"command":"pwd"}},7]'
        ]
    ])('rejects %s', (_label, text) => {
        expect(gate(text)).toBe('malformed_external_tool_call');
    });

    test('rejects a nested canonical exception followed by another unclosed block', () => {
        const text = '<function_calls><function_calls>{"name":"bash","arguments":{"command":"ls"}}</function_calls><function_calls>{"name":"bash"';
        expect(gate(text)).toBe('malformed_external_tool_call');
    });

    test.each([
        ['<tool_calls>', '<tool_calls>'],
        ['<\u200btool_call>', '<\u200btool_call>']
    ])('does not treat %s inside a JSON string as an envelope', (_label, marker) => {
        const text = `<function_calls>{"name":"external__bash","arguments":{"command":"printf '%s'"}}</function_calls>`;
        const marked = text.replace('printf', `printf ${marker}`);
        const calls = parseExternalToolCallsFromText(registry, marked);
        expect(calls).toHaveLength(1);
        expect(JSON.parse(calls[0].function.arguments).command).toContain(marker);
        expect(gate(marked)).toBeNull();
    });

    test('accepts a complete zero-argument function dialect call', () => {
        const pingRegistry = buildExternalToolRegistry([{
            type: 'function',
            function: { name: 'ping', parameters: { type: 'object', properties: {}, required: [] } }
        }]);
        const text = '<function=ping></function>';
        const calls = parseExternalToolCallsFromText(pingRegistry, text);
        expect(calls).toHaveLength(1);
        expect(calls[0].function.name).toBe('ping');
        expect(JSON.parse(calls[0].function.arguments)).toEqual({});
        expect(() => assertToolCallArtifactIntegrity(calls, pingRegistry, text)).not.toThrow();
    });

    test.each([
        ['an ordinary JSON object', '{"ordinaryLeading":true}'],
        ['an ordinary array', '[1,2,3]'],
        ['a named JSON body outside the registry', '{"name":"totally_other","arguments":{}}'],
        ['a valid canonical block', '<function_calls>{"name":"bash","arguments":{"command":"ls"}}</function_calls>'],
        ['an explicit nested canonical wrapper', '<function_calls>\n<function_calls>\n{"name":"bash","arguments":{"command":"ls"}}\n</function_calls>'],
        ['a prefixed canonical payload', '<function_calls>calling tool: {"name":"bash","arguments":{"command":"pwd"}}</function_calls>'],
        ['a valid bare call', '{"name":"bash","arguments":{"command":"ls"}}'],
        ['a valid bare array', '[{"name":"bash","arguments":{"command":"ls"}},{"name":"read","arguments":{"file":"a.txt"}}]'],
        [
            'a valid DSML container',
            '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="bash"><｜｜DSML｜｜parameter name="command" string="true">ls</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>'
        ],
        ['prose', 'just some prose about running commands']
    ])('accepts %s', (_label, text) => {
        expect(gate(text)).toBeNull();
    });

    test.each([
        [
            'canonical JSON with a conflicting payload',
            '<function_calls>[{"id":"same","name":"bash","arguments":{"command":"ls"}},{"id":"same","name":"bash","arguments":{"command":"pwd"}}]</function_calls>'
        ],
        [
            'canonical JSON with an unknown trailing payload',
            '<function_calls>{"name":"bash","arguments":{"command":"ls"}}{"name":"missing","arguments":{}}</function_calls>'
        ],
        [
            'canonical JSON with malformed trailing text',
            '<function_calls>{"name":"bash","arguments":{"command":"ls"}}{"name":"bash" arguments</function_calls>'
        ],
        [
            'DSML with a later unclosed invoke',
            '<tool_calls><invoke name="bash"><parameter name="command">ls</parameter></invoke><invoke name="read"><parameter name="file">a.txt</parameter></tool_calls>'
        ],
        [
            'DSML with an unclosed parameter',
            '<tool_calls><invoke name="bash"><parameter name="command">ls</invoke></tool_calls>'
        ],
        [
            'tool wrapper JSON with an unknown trailing payload',
            '<tool_call>{"name":"bash","arguments":{"command":"ls"}}{"name":"missing","arguments":{}}</tool_call>'
        ],
        [
            'tool wrapper JSON with malformed trailing text',
            '<tool_call>{"name":"bash","arguments":{"command":"ls"}} trailing</tool_call>'
        ],
        [
            'tool wrapper function call with trailing text',
            '<tool_call><function=bash><parameter=command>ls</parameter></function> trailing</tool_call>'
        ],
        [
            'tool wrapper tag call with trailing text',
            '<tool_call><external__bash>{"command":"ls"}</external__bash> trailing</tool_call>'
        ],
        [
            'bare array without its closing bracket',
            '[{"name":"bash","arguments":{"command":"ls"}}'
        ],
        [
            'bare array followed by a second payload',
            '[{"name":"bash","arguments":{"command":"ls"}}] {"name":"bash","arguments":{"command":"pwd"}}'
        ],
        [
            'bare array with an unknown member',
            '[{"name":"bash","arguments":{"command":"ls"}},{"name":"missing","arguments":{}}]'
        ],
        [
            'a valid canonical block followed by a second bare payload',
            '<function_calls>{"name":"bash","arguments":{"command":"ls"}}</function_calls>{"name":"bash","arguments":{"command":"pwd"}}'
        ],
        [
            'a valid DSML container followed by a second bare payload',
            '<tool_calls><invoke name="bash"><parameter name="command">ls</parameter></invoke></tool_calls>{"name":"bash","arguments":{"command":"pwd"}}'
        ],
        [
            'a valid <tool_call> wrapper followed by a second bare payload',
            '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>{"name":"bash","arguments":{"command":"pwd"}}'
        ],
        [
            'a bare payload truncated behind a fuzzy tool alias',
            '{"name":"externalbash","arguments":{"command":"ls"'
        ],
        [
            'a bare array truncated behind a fuzzy tool alias',
            '[{"name":"externalbash","arguments":{"command":'
        ]
    ])('rejects %s', (_label, text) => {
        expect(gate(text)).not.toBeNull();
    });

    test('does not emit or hide a non-JSON wrapper call with trailing content', () => {
        const text = '<tool_call><function=read><parameter=file>a.txt</parameter></function> trailing</tool_call>';
        expect(parseExternalToolCallsFromText(registry, text)).toEqual([]);
        expect(stripFunctionCallMarkup(text, false, { registry })).toContain('trailing');
    });

    test('never parses a second bare payload after a canonical block', () => {
        const text = '<function_calls>{"name":"bash","arguments":{"command":"ls"}}</function_calls>{"name":"bash","arguments":{"command":"pwd"}}';
        expect(gate(text)).toBe('malformed_external_tool_call');
        expect(parseExternalToolCallsFromText(registry, text)).toHaveLength(1);
    });

    test('resolves a fuzzy tool alias in a bare payload through the registry', () => {
        const calls = parseExternalToolCallsFromText(registry, '{"name":"externalbash","arguments":{"command":"ls"}}');
        expect(calls).toHaveLength(1);
        expect(calls[0].function.name).toBe('bash');
        expect(gate('{"name":"externalbash","arguments":{"command":"ls"}}')).toBeNull();
    });

    test('does not leak an unclosed naked invoke', () => {
        const text = '<invoke name="bash"><parameter name="command">ls';
        expect(parseExternalToolCallsFromText(registry, text)).toEqual([]);
        expect(stripFunctionCallMarkup(text)).toBe('');
        expect(gate(text)).toBe('malformed_external_tool_call');
    });
});

describe('joined bare tool-call sanitizer', () => {
    const bare = '{"name":"bash","arguments":{"command":"ls"}}';

    test('removes a bare call from the content channel and keeps reasoning text', () => {
        expect(stripExternalToolCallMarkupFromJoinedText(registry, 'let me check that', bare)).toEqual({
            reasoning: 'let me check that',
            content: ''
        });
    });

    test('removes a bare call from the reasoning channel and keeps content text', () => {
        expect(stripExternalToolCallMarkupFromJoinedText(registry, bare, 'here is the answer')).toEqual({
            reasoning: '',
            content: 'here is the answer'
        });
    });

    test('removes a bare call from the content channel with a trailing space', () => {
        expect(stripExternalToolCallMarkupFromJoinedText(registry, 'thinking', `  ${bare}  `, true)).toEqual({
            reasoning: 'thinking',
            content: ''
        });
    });

    test('removes a bare call that is the only content of both channels', () => {
        expect(stripExternalToolCallMarkupFromJoinedText(registry, bare, 'plain tail')).toEqual({
            reasoning: '',
            content: 'plain tail'
        });
    });

    test.each([
        ['an ordinary JSON object', '{"ordinaryLeading":true}'],
        ['a non-tool array', '[1,2,3]'],
        ['a named JSON body outside the registry', '{"name":"totally_other","arguments":{}}']
    ])('keeps %s in the content channel', (_label, text) => {
        expect(stripExternalToolCallMarkupFromJoinedText(registry, 'thinking', text)).toEqual({
            reasoning: 'thinking',
            content: text
        });
    });

    test('keeps an ordinary JSON body in the reasoning channel', () => {
        expect(stripExternalToolCallMarkupFromJoinedText(registry, '{"ordinaryLeading":true}', 'answer')).toEqual({
            reasoning: '{"ordinaryLeading":true}',
            content: 'answer'
        });
    });

    test('still strips a bare call from the joined single-channel view', () => {
        expect(stripExternalToolCallMarkupFromJoinedText(registry, '', bare, true)).toEqual({
            reasoning: '',
            content: ''
        });
    });
});

describe('bare payload source views', () => {
    const bare = '{"name":"bash","arguments":{"command":"ls"}}';
    const gateChannels = (channels) => {
        try {
            assertToolCallArtifactIntegrity(
                parseExternalToolCallsFromJoinedText(registry, channels[0] ?? '', channels[1] ?? ''),
                registry,
                channels
            );
            return null;
        } catch (error) {
            return error.code;
        }
    };
    const gateGroups = (groups) => {
        try {
            assertToolCallArtifactIntegrity(
                mergeToolCallArtifacts(...groups.map((group) => parseExternalToolCallsFromJoinedText(registry, group[0] ?? '', group[1] ?? ''))),
                registry,
                groups
            );
            return null;
        } catch (error) {
            return error.code;
        }
    };

    test('accepts a bare payload split across the reasoning and content channels', () => {
        const reasoning = '{"name":"bash","arguments":{"command":';
        const content = '"ls"}}';
        const calls = parseExternalToolCallsFromJoinedText(registry, reasoning, content);
        expect(calls).toHaveLength(1);
        expect(JSON.parse(calls[0].function.arguments)).toEqual({ command: 'ls' });
        expect(gateChannels([reasoning, content])).toBeNull();
        expect(stripExternalToolCallMarkupFromJoinedText(registry, reasoning, content, true)).toEqual({
            reasoning: '',
            content: ''
        });
    });

    test('rejects a split bare payload that never closes in the joined view', () => {
        expect(gateChannels(['{"name":"bash","arguments":{"command":', '"ls"'])).toBe('malformed_external_tool_call');
    });

    test('keeps ordinary JSON and arrays in either channel', () => {
        expect(gateChannels(['{"ordinaryLeading":true}', '[1,2,3]'])).toBeNull();
        expect(stripExternalToolCallMarkupFromJoinedText(registry, '{"ordinaryLeading":true}', '[1,2,3]', true)).toEqual({
            reasoning: '{"ordinaryLeading":true}',
            content: '[1,2,3]'
        });
    });

    test('keeps a bare payload that owns one channel while the other carries prose', () => {
        expect(gateChannels([bare, 'the result is 42'])).toBeNull();
        expect(stripExternalToolCallMarkupFromJoinedText(registry, bare, 'the result is 42', true)).toEqual({
            reasoning: '',
            content: 'the result is 42'
        });
    });

    test('separates the joined view from the per-channel view', () => {
        const opener = '<function_calls>{"name":"bash","arguments":{"command":"ls"}}';
        const closer = '</function_calls>';
        expect(gateChannels([opener, closer])).toBeNull();
        expect(gateGroups([[opener], [closer]])).toBe('malformed_external_tool_call');
    });

    test('checks each grouped document on its own joined view', () => {
        expect(gateGroups([[bare], ['answer text']])).toBeNull();
        expect(gateGroups([['{"ordinaryLeading":true}'], [bare]])).toBeNull();
        expect(
            gateGroups([['<function_calls>{"name":"bash","arguments":{"command":"ls"}}</function_calls>{"name":"bash","arguments":{"command":"pwd"}}']])
        ).toBe('malformed_external_tool_call');
    });
});
