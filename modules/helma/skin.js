/*global getResource importModule parseSkin */

loadModule('core.string');
loadModule('core.object');
var filters = loadModule('helma.filters');
var log = loadModule('helma.logging').getLogger(__name__);

/**
 * Parse a skin from a resource and render it using the given context.
 * @param skinOrPath a skin object or a file name
 * @param context the skin render context
 * @param scope optional scope object for relative resource lookup
 * @param buffer the Buffer object to write to
 */
function render(skinOrPath, context, scope, buffer) {
    scope = scope || this;
    var skin;
    if (typeof(skinOrPath.render) == "function") {
        skin = skinOrPath;
    } else if (typeof(skinOrPath) == "string") {
        var subskin;
        if (skinOrPath.indexOf('#') > -1) {
            [skinOrPath, subskin] = skinOrPath.split('#');
        }
        var resource = scope.getResource(skinOrPath);
        skin = createSkin(resource, scope);
        if (subskin) {
            skin = skin.getSubskin(subskin);
        }
    } else {
        throw Error("Unknown skin object: " + skinOrPath);
    }
    skin.render(context, buffer);
}

/**
 * Parse a skin from a resource.
 * @param resource
 */
function createSkin(resourceOrString, scope) {
    log.debug("creating skin: " + resourceOrString);
    var mainSkin = [];
    var subSkins = {};
    var currentSkin = mainSkin;
    var parentSkin = null;
    parseSkin(resourceOrString, function(part) {
        if (part.name === 'extends') {
            var skinPath = part.getParameter(0);
            var skinResource;
            if (resourceOrString.parentRepository) {
                skinResource = resourceOrString.parentRepository.getResource(skinPath);
            }
            if (!skinResource || !skinResource.exists()) {
                skinResource = scope.getResource(skinPath);
            }
            parentSkin = createSkin(skinResource);
        } else if (part.name === 'subskin')  {
            var skinName = part.getParameter('name', 0);
            currentSkin = [];
            subSkins[skinName] = currentSkin;
        } else {
            currentSkin[currentSkin.length] = part;
        }
    });
    // normalization: cut trailing whitespace so it's
    // easier to tell if main skin shoule be inherited
    var lastPart = mainSkin[mainSkin.length - 1];
    if (typeof(lastPart) === 'string' && lastPart.trim() === '') {
        mainSkin.pop();
    }
    return new Skin(mainSkin, subSkins, parentSkin);
}

/**
 * The Skin object. This takes an array of skin parts (literal strings and MacroTags)
 * and a dictionary of subskins.
 * @param mainSkin an array of skin parts: string literals and macro tags
 * @param subSkins a dictionary of named skin components
 */
function Skin(mainSkin, subSkins, parentSkin) {

    var self = this;

    this.render = function(context, buffer) {
        if (mainSkin.length === 0 && parentSkin) {
            renderInternal(parentSkin.getSkinParts(), context, buffer);
        } else {
            renderInternal(mainSkin, context, buffer);
        }
    };

    this.renderSubskin = function(skinName, context, buffer) {
        if (!subSkins[skinName] && parentSkin) {
            renderInternal(parentSkin.getSkinParts(skinName), context, buffer);
        } else {
            renderInternal(subSkins[skinName], context, buffer);
        }
    };

    this.getSubskin = function(skinName) {
        if (subSkins[skinName]) {
            return new Skin(subSkins[skinName], subSkins, parentSkin);
        } else {
            return null;
        }
    };

    this.getSkinParts = function(skinName) {
        var parts = skinName ? subSkins[skinName] : mainSkin;
        if (!parts || (!skinName && parts.length === 0)) {
            return parentSkin ? parentSkin.getSkinParts(skinName) : null;
        }
        return parts;
    };

    var renderInternal = function(parts, context, buffer) {
        for (var i in parts) {
            var part = parts[i];
            if (part instanceof MacroTag) {
                if (part.name) {
                    evaluateMacro(part, context, buffer);
                }
            } else {
                buffer.write(part);
            }
        }
    };

    var evaluateMacro = function(macro, context, buffer) {
        var length = buffer.length;
        var value = evaluateExpression(macro, context, '_macro', undefined, buffer);
        var visibleValue = isVisible(value);
        var wroteSomething = buffer.length > length;

        // check if macro has a filter, if so extra work ahead
        var filter = macro.filter;
        while (filter) {
            // make sure value is not undefined,
            // otherwise evaluateExpression() might become confused
            if (!visibleValue) {
                value = "";
            }
            if (wroteSomething) {
                var written = buffer.truncate(length);
                if (visibleValue) {
                    value = written + value;
                } else {
                    value = written;
                }
            }
            value = evaluateExpression(filter, filters, '_filter', value, buffer);
            visibleValue = isVisible(value);
            wroteSomething = buffer.length > length;
            filter = filter.filter;
        }
        if (visibleValue) {
            buffer.write(value);
        }
    };

    var evaluateExpression = function(macro, context, suffix, value, buffer) {
        log.debug('evaluating expression: ' + macro);
        if (builtins[macro.name]) {
            return builtins[macro.name](macro, context, buffer);
        }
        var path = macro.name.split('.');
        var elem = context;
        var length = path.length;
        var last = path[length-1];
        for (var i = 0; i < length - 1; i++) {
            elem = elem[path[i]];
            if (!isDefined(elem)) {
                break;
            }
        }
        if (isDefined(elem)) {
            if (elem[last + suffix] instanceof Function) {
                return value === undefined ?
                       elem[last + suffix].call(elem, macro, self, context) :
                       elem[last + suffix].call(elem, value, macro, self, context);
            } else if (value === undefined && isDefined(elem[last])) {
                if (elem[last] instanceof Function) {
                    return elem[last].call(elem, macro, self, context);
                } else {
                    return elem[last];
                }
            }
        }
        // TODO: if filter is not found just return value as is
        return value;
    };

    var isDefined = function(elem) {
        return elem !== undefined && elem !== null;
    }

    var isVisible = function(elem) {
        return elem !== undefined && elem !== null && elem !== '';
    }

    // builtin macro handlers
    var builtins = {
        render: function(macro, context, buffer) {
            var skin = getEvaluatedParameter(macro.getParameter(0), context, 'render:skin');
            var bind = getEvaluatedParameter(macro.getParameter('bind'), context, 'render:bind');
            var on = getEvaluatedParameter(macro.getParameter('on'), context, 'render:on');
            var as = getEvaluatedParameter(macro.getParameter('as'), context, 'render:as');
            var subContext = context.clone();
            if (bind) {
                for (var b in bind) {
                    subContext[b] = getEvaluatedParameter(bind[b], context, 'render:bind:value');
                }
            }
            if (on) {
                var subContext = context.clone();
                for (var [key, value] in on) {
                    log.debug("key: " + value);
                    subContext[('key')] = key;
                    subContext[(as || 'value')] = value;
                    self.renderSubskin(skin, subContext, buffer);
                }
            } else {
                self.renderSubskin(skin, subContext, buffer);
            }
        }

    };

    var getEvaluatedParameter = function(value, context, logprefix) {
        log.debug(logprefix + ': macro called with value: ' + value);
        if (value instanceof MacroTag) {
            value = evaluateExpression(value, context, '_macro');
            log.debug(logprefix + ': evaluated value macro, got ' + value);
        }
        return value;
    }

    this.toString = function() {
        return "[Skin Object]";
    };

}
