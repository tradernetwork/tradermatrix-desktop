Options seller lens (reference card, version 1). It defines terms and says how to read the numbers in the digest. It describes; it does not advise.

Words
- Premium seller: the side of an option trade that is paid up front. The seller keeps the premium if the contract expires worthless and carries the risk if price moves through the strike.
- Strike is the price written into the contract. DTE is the number of days left to expiry.
- Delta: roughly how much the option price moves for a one dollar move in the stock. Read its size as a rough market-implied chance of finishing in the money (0.20 is about 20%). Puts carry negative deltas; the size is what matters for the chance.
- Theta: the time value an option loses per day, all else equal. Decay speeds up in the last weeks before expiry.
- IV is implied volatility, the size of move that option prices are pricing in. IV rank places today's IV inside its own past year on a 0 to 100 scale: 0 is the lowest it traded, 100 the highest. It says IV is high or low against its own history, not that options are cheap or dear in absolute terms.
- Expected move: the one standard deviation range implied by option prices over a horizon. Price finishes inside the 68% band about two times in three. It is a range, not a forecast.

How to read the digest
- STRIKE em_units: the distance from spot to the strike, measured in expected moves. Under 1 means the strike sits inside the expected range, over 1 means outside it. Larger means further out relative to what options imply.
- STRIKE wall: the nearest Apex level (a dealer positioning level) toward the strike. A level between spot and strike is a map feature, not a barrier that holds.
- STRIKE earnings_inside: true means an earnings date falls before expiry, so the move can arrive as a gap that the normal range understates.
- STRIKE verdict (protected, exposed, event, unknown) is the app's label built from those checks. Explain what each check measured; it is not a signal.
- CONTRACT delta, mid and iv are that contract's own numbers. Mid is halfway between bid and ask: an estimate of price, not a fill.
- LEVELS flip: the price where dealer gamma changes sign. Above it, hedging tends to damp moves; below it, hedging can amplify them. A positioning map, not a target.

What the data cannot tell you
- Whether a strike will be touched. Delta and expected move are market-implied odds, not outcomes.
- Skew, open interest, per-contract bid and ask depth, assignment or early exercise risk, margin, or buying power.
- Whether a position is naked, covered or a spread, which decides the worst case. If the digest does not show it, say so.
- Anything about the user's other positions unless POS or HELD lines are present.
- Never say what to sell, which strike to pick, how many contracts, or when to close. Describe what the numbers show and stop there.
