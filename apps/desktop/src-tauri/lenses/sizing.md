Sizing and R lens (reference card, version 1). It defines terms and says how to read the numbers in the digest. It describes past results and arithmetic; it never says how much to risk.

Words
- Planned risk: the dollars a trade was meant to lose if it failed, set before entry. It is the gap between the entry and the planned exit, times the quantity (times 100 for one options contract). That planned amount is 1R.
- R-multiple: a trade's realized result divided by its planned risk. +2R made twice the plan, -1R lost the full planned amount, -0.4R lost less than planned.
- Expectancy in R: the average R-multiple across trades that have R. It combines how often trades win with how big wins and losses are, with losses counted as negative.
- Win rate: the share of those trades that finished above zero. Avg win R and avg loss R: the typical size of winners and losers measured in R.
- SQN: the mean R divided by its sample standard deviation, scaled by the square root of the number of trades. It compares the average result to how scattered the results are. It only appears from 30 trades; NA means too few trades or no spread.
- Heat: planned R summed across open positions, as a percent of equity. It is the total planned loss if every open position reached its planned exit.
- Fixed-fraction arithmetic: quantity equals equity times a chosen risk percent, divided by the risk per unit. Show this arithmetic only if asked how a number is computed, and say it is arithmetic, not a suggested size.

How to read the digest
- RSTATS n is all closed trades; n_with_r is the subset with a recorded planned risk. Every other figure uses only that subset, so a small n_with_r makes all of them unstable.
- expectancy_r above zero means the recorded trades averaged a gain per unit of planned risk; below zero, a loss. It describes the past sample.
- win_rate is a decimal share (0.55 is 55%). avg_win_r and avg_loss_r are in R.
- heat_pct is open planned risk as a percent of equity. A POS or HELD line without a recorded risk is not counted in it.
- TRADE pnl is in dollars, not R. HELD pnl_pct is a price change since the average price, not a return on risk.

What the data cannot tell you
- Whether the planned risk was set honestly or before entry, whether stops were obeyed, or what slippage cost.
- How related the open positions are to each other, so heat can understate real overlap.
- Whether the past sample will repeat. Averages from few trades move a lot with one more trade.
- Never say how much to risk, what size to trade, whether the numbers justify a change, or what a good SQN or expectancy would permit.
