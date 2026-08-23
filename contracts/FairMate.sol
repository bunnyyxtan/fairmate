// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * FairMate v2 contracts.
 *
 * Trust model, stated exactly:
 *  - The REFEREE (the FairMate server wallet) is the only journal writer. The
 *    chain provides a tamper-evident, timestamped, public record binding each
 *    game's board states and moves to TEE inference evidence. The exact
 *    off-chain checks depend on the evidence scheme: direct TeeML exposes raw
 *    signatures; Router TeeTLS exposes a Router-verified trace. In both cases
 *    the journal commits the evidence hash without interpreting it.
 *  - The ChallengePot is bound ON-CHAIN to the journal: an award can only pay
 *    the player address recorded at game start, only for a game the journal
 *    records as PlayerWin, and only once. `award` is permissionless — once a
 *    win is recorded, the referee cannot withhold or redirect the payout.
 *  - Residual trust: the referee decides and records the game result. Anyone
 *    can replay the committed SAN line and check the final position; a
 *    misrecorded result is publicly provable from the journal itself.
 */

/// Per-game journal: board-state commitments bound to TEE evidence hashes.
contract MoveJournal {
    enum Result {
        Ongoing,
        PlayerWin,
        ModelWin,
        Draw,
        Aborted
    }

    /// mover values in MoveCommitted
    uint8 public constant MOVER_PLAYER = 0;
    uint8 public constant MOVER_MODEL = 1;

    struct GameMeta {
        bytes32 startFenHash;
        address player;
        uint64 startedAt;
        uint64 endedAt;
        uint32 moveCount;
        Result result;
        bool exists;
    }

    address public immutable referee;
    mapping(bytes32 => GameMeta) public games;

    event GameStarted(
        bytes32 indexed gameId,
        bytes32 startFenHash,
        address indexed player,
        string model,
        address verificationIdentity
    );
    event MoveCommitted(
        bytes32 indexed gameId,
        uint32 indexed moveNo,
        uint8 mover,
        bytes32 fenBeforeHash,
        bytes32 fenAfterHash,
        string san,
        bytes32 receiptHash
    );
    event GameEnded(bytes32 indexed gameId, Result result, bytes32 finalFenHash, uint32 moveCount);

    error NotReferee();
    error GameAlreadyExists();
    error NoSuchGame();
    error GameAlreadyEnded();
    error ZeroHash();
    error BadMover();
    error ModelMoveNeedsReceipt();
    error BadResult();

    modifier onlyReferee() {
        if (msg.sender != referee) revert NotReferee();
        _;
    }

    constructor() {
        referee = msg.sender;
    }

    function startGame(
        bytes32 gameId,
        bytes32 startFenHash,
        address player,
        string calldata model,
        address verificationIdentity
    ) external onlyReferee {
        if (games[gameId].exists) revert GameAlreadyExists();
        if (startFenHash == bytes32(0)) revert ZeroHash();
        games[gameId] = GameMeta({
            startFenHash: startFenHash,
            player: player,
            startedAt: uint64(block.timestamp),
            endedAt: 0,
            moveCount: 0,
            result: Result.Ongoing,
            exists: true
        });
        emit GameStarted(gameId, startFenHash, player, model, verificationIdentity);
    }

    /// Commit one move. Model moves (mover=1) MUST carry a TEE evidence hash;
    /// player moves (mover=0) carry receiptHash=0 (humans do not emit receipts).
    function commitMove(
        bytes32 gameId,
        uint8 mover,
        bytes32 fenBeforeHash,
        bytes32 fenAfterHash,
        string calldata san,
        bytes32 receiptHash
    ) external onlyReferee returns (uint32 moveNo) {
        GameMeta storage g = games[gameId];
        if (!g.exists) revert NoSuchGame();
        if (g.result != Result.Ongoing) revert GameAlreadyEnded();
        if (fenBeforeHash == bytes32(0) || fenAfterHash == bytes32(0)) revert ZeroHash();
        if (mover > MOVER_MODEL) revert BadMover();
        if (mover == MOVER_MODEL && receiptHash == bytes32(0)) revert ModelMoveNeedsReceipt();
        g.moveCount += 1;
        moveNo = g.moveCount;
        emit MoveCommitted(gameId, moveNo, mover, fenBeforeHash, fenAfterHash, san, receiptHash);
    }

    /// Record the final result. Irreversible; further commits revert.
    function endGame(bytes32 gameId, Result result, bytes32 finalFenHash) external onlyReferee {
        GameMeta storage g = games[gameId];
        if (!g.exists) revert NoSuchGame();
        if (g.result != Result.Ongoing) revert GameAlreadyEnded();
        if (result == Result.Ongoing) revert BadResult();
        if (finalFenHash == bytes32(0)) revert ZeroHash();
        g.result = result;
        g.endedAt = uint64(block.timestamp);
        emit GameEnded(gameId, result, finalFenHash, g.moveCount);
    }

    function getGame(bytes32 gameId) external view returns (GameMeta memory) {
        return games[gameId];
    }

    function moveCount(bytes32 gameId) external view returns (uint32) {
        if (!games[gameId].exists) revert NoSuchGame();
        return games[gameId].moveCount;
    }
}

/// Builder-funded challenge pot, bound on-chain to the MoveJournal.
/// Free entry; money only flows OUT — to the player recorded in the journal.
contract ChallengePot {
    MoveJournal public immutable journal;
    address public immutable owner;
    uint256 public perWinBounty;
    uint256 public dailyCap;
    uint256 public paidInWindow;
    uint64 public windowStart;
    mapping(bytes32 => bool) public rewarded;

    event Funded(address indexed from, uint256 amount);
    event BountyConfigured(uint256 perWinBounty, uint256 dailyCap);
    event WinAwarded(bytes32 indexed gameId, address indexed winner, uint256 amount);
    event Defunded(address indexed to, uint256 amount);

    error NotOwner();
    error AlreadyRewarded();
    error BountyNotConfigured();
    error DailyCapExceeded();
    error InsufficientPot();
    error TransferFailed();
    error ZeroAddress();
    error NoSuchGame();
    error GameNotEnded();
    error NotPlayerWin();
    error NoPlayerRecorded();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(MoveJournal journal_) {
        if (address(journal_) == address(0)) revert ZeroAddress();
        journal = journal_;
        owner = msg.sender;
        windowStart = uint64(block.timestamp);
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    function configureBounty(uint256 perWinBounty_, uint256 dailyCap_) external onlyOwner {
        perWinBounty = perWinBounty_;
        dailyCap = dailyCap_;
        emit BountyConfigured(perWinBounty_, dailyCap_);
    }

    /**
     * Award the bounty for a journal-recorded player win. PERMISSIONLESS:
     * anyone may trigger it, because every condition and the payee are read
     * from the journal. The referee cannot redirect a payout, pay a game that
     * was not won, pay twice, or exceed the configured caps.
     */
    function award(bytes32 gameId) external {
        if (rewarded[gameId]) revert AlreadyRewarded();
        if (perWinBounty == 0) revert BountyNotConfigured();

        MoveJournal.GameMeta memory g = journal.getGame(gameId);
        if (!g.exists) revert NoSuchGame();
        if (g.result == MoveJournal.Result.Ongoing) revert GameNotEnded();
        if (g.result != MoveJournal.Result.PlayerWin) revert NotPlayerWin();
        if (g.player == address(0)) revert NoPlayerRecorded();

        // roll the 24h window
        if (block.timestamp >= uint256(windowStart) + 1 days) {
            windowStart = uint64(block.timestamp);
            paidInWindow = 0;
        }
        if (paidInWindow + perWinBounty > dailyCap) revert DailyCapExceeded();
        if (address(this).balance < perWinBounty) revert InsufficientPot();

        rewarded[gameId] = true;
        paidInWindow += perWinBounty;
        (bool ok, ) = payable(g.player).call{ value: perWinBounty }("");
        if (!ok) revert TransferFailed();
        emit WinAwarded(gameId, g.player, perWinBounty);
    }

    /// Owner can reclaim remaining pot (shutting the challenge down is public).
    function defund(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (address(this).balance < amount) revert InsufficientPot();
        (bool ok, ) = to.call{ value: amount }("");
        if (!ok) revert TransferFailed();
        emit Defunded(to, amount);
    }

    function potBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
