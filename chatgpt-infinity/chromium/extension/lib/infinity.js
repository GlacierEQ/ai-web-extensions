// Requires lib/chatgpt.min.js
// Requires lib/deep-dive.js (loaded before this file)

window.infinity = {

    isRunning: false, // re-entrancy guard — prevents stacked continue() calls

    async activate() {
        const activatePrompt = 'Generate a single random question'
            +( app.config.replyLanguage ? ( ' in ' + app.config.replyLanguage ) : '' )
            +( ' on ' + ( app.config.replyTopic == 'ALL' ? 'ALL topics' : 'the topic of ' + app.config.replyTopic ))
            + ' then answer it. Don\'t type anything else.'
        if (env.browser.isMobile && chatgpt.sidebar.isOn()) chatgpt.sidebar.hide()
        if (!new URL(location).pathname.startsWith('/g/'))
            try { chatgpt.startNewChat() } catch (err) { return }
        await new Promise(resolve => setTimeout(resolve, 500))
        chatgpt.send(activatePrompt)
        await new Promise(resolve => setTimeout(resolve, 3000))
        if (!document.querySelector('[data-message-author-role]')
            && app.config.infinityMode
        ) chatgpt.send(activatePrompt)

        // Wait for full idle + DOM settle before scheduling next turn
        await chatgpt.isIdle()
        await new Promise(resolve => setTimeout(resolve, 600)) // settle buffer

        if (app.config.infinityMode && !infinity.isActive)
            infinity.isActive = setTimeout(infinity.continue, parseInt(app.config.replyInterval, 10) * 1000)
    },

    async continue() {
        // Re-entrancy guard — never run two concurrent continue() calls
        if (infinity.isRunning) return
        infinity.isRunning = true

        try {
            if (!app.config.autoScrollDisabled) try { chatgpt.scrollToBottom() } catch(err) {}

            // ── CRITICAL ORDER ─────────────────────────────────────────────────
            // 1. Confirm ChatGPT is fully idle FIRST (stop button gone)
            // 2. Add a 600ms settle buffer for DOM to stabilise post-stream
            // 3. ONLY THEN read the last reply and build the next prompt
            // 4. THEN send — never mid-stream
            // ───────────────────────────────────────────────────────────────────
            await chatgpt.isIdle()
            await new Promise(resolve => setTimeout(resolve, 600)) // DOM settle

            // Build intelligent follow-up (or fallback)
            let nextPrompt = 'Do it again.'
            if (typeof deepDive !== 'undefined') {
                try {
                    const lastReply = await chatgpt.getLastResponse()
                    if (lastReply && lastReply.trim().length > 40)
                        nextPrompt = deepDive.nextPrompt(lastReply, app.config.replyTopic || '')
                } catch (e) {
                    console.warn('[DeepDive] getLastResponse failed, using fallback:', e)
                }
            }

            // Bail out if user deactivated during the settle wait
            if (!app.config.infinityMode) return

            chatgpt.send(nextPrompt)

            // Wait for the NEW response to complete before scheduling next turn
            await chatgpt.isIdle()
            await new Promise(resolve => setTimeout(resolve, 600)) // settle again

        } finally {
            infinity.isRunning = false
            // Schedule next turn only if still active
            if (infinity.isActive && app.config.infinityMode)
                infinity.isActive = setTimeout(infinity.continue, parseInt(app.config.replyInterval, 10) * 1000)
        }
    },

    deactivate() {
        if (chatgpt.getStopBtn()) chatgpt.stop()
        clearTimeout(infinity.isActive)
        infinity.isActive  = null
        infinity.isRunning = false // clear guard so restart works cleanly
        if (typeof deepDive !== 'undefined') deepDive.reset()
    },

    async restart(options = { target: 'new' }) {
        if (options.target == 'new') {
            infinity.deactivate()
            setTimeout(() => infinity.activate(), 750)
        } else {
            clearTimeout(infinity.isActive)
            infinity.isActive  = null
            infinity.isRunning = false
            await chatgpt.isIdle()
            await new Promise(resolve => setTimeout(resolve, 600))
            if (app.config.infinityMode && !infinity.isActive)
                infinity.isActive = setTimeout(infinity.continue, parseInt(app.config.replyInterval, 10) * 1000)
        }
    }
};
