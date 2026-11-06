// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Native-asset prepaid sessions. Experimental: test funds pending independent review.
/// No owner, upgrade mechanism, intermediary payee or per-query chain transaction.
contract QueryEscrow {
    struct Session {
        address payer;
        address operator;
        address sessionKey;
        uint256 deposit;
        uint64 refundAfter;
        bool closed;
    }

    uint64 public constant SESSION_DURATION = 1 days;
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant VOUCHER_TYPEHASH = keccak256("Voucher(uint256 sessionId,uint256 amount)");
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    uint256 public nextSessionId = 1;
    mapping(uint256 => Session) public sessions;
    mapping(address => uint256) public pendingWithdrawals;
    bool private entered;

    event Opened(uint256 indexed sessionId, address indexed payer, address indexed operator, address sessionKey, uint256 deposit, uint64 refundAfter);
    event ToppedUp(uint256 indexed sessionId, uint256 deposit);
    event Closed(uint256 indexed sessionId, uint256 paid, uint256 refunded);
    event Refunded(uint256 indexed sessionId, uint256 amount);
    event WithdrawalDeferred(address indexed recipient, uint256 amount);

    error InvalidSession();
    error Unauthorized();
    error InvalidVoucher();
    error Deadline();
    error Reentrant();
    error TransferFailed();

    modifier nonReentrant() {
        if (entered) revert Reentrant();
        entered = true;
        _;
        entered = false;
    }

    function open(address operator, address sessionKey) external payable nonReentrant returns (uint256 id) {
        if (operator == address(0) || sessionKey == address(0) || msg.value == 0) revert InvalidSession();
        id = nextSessionId++;
        uint64 refundAfter = uint64(block.timestamp + SESSION_DURATION);
        sessions[id] = Session(msg.sender, operator, sessionKey, msg.value, refundAfter, false);
        emit Opened(id, msg.sender, operator, sessionKey, msg.value, refundAfter);
    }

    /// @notice Increase the spend cap without extending the operator's settlement deadline.
    function topUp(uint256 id) external payable nonReentrant {
        Session storage s = sessions[id];
        if (s.closed || s.payer == address(0) || msg.value == 0) revert InvalidSession();
        if (msg.sender != s.payer) revert Unauthorized();
        if (block.timestamp >= s.refundAfter) revert Deadline();
        s.deposit += msg.value;
        emit ToppedUp(id, s.deposit);
    }

    function voucherDigest(uint256 id, uint256 amount) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("DeRPC Query Escrow"), keccak256("1"), block.chainid, address(this)));
        return keccak256(abi.encodePacked(hex"1901", domain, keccak256(abi.encode(VOUCHER_TYPEHASH, id, amount))));
    }

    /// @notice Pay the operator once from the highest signed cumulative total; return the rest.
    function close(uint256 id, uint256 amount, bytes calldata signature) external nonReentrant {
        Session storage s = sessions[id];
        if (s.closed || s.payer == address(0)) revert InvalidSession();
        if (msg.sender != s.operator) revert Unauthorized();
        if (block.timestamp >= s.refundAfter) revert Deadline();
        if (amount > s.deposit || signature.length != 65) revert InvalidVoucher();
        bytes32 r;
        bytes32 sigS;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            sigS := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(sigS) == 0 || uint256(sigS) > HALF_ORDER || (v != 27 && v != 28)) revert InvalidVoucher();
        if (ecrecover(voucherDigest(id, amount), v, r, sigS) != s.sessionKey) revert InvalidVoucher();
        s.closed = true;
        uint256 remainder = s.deposit - amount;
        _pay(s.operator, amount);
        _pay(s.payer, remainder);
        emit Closed(id, amount, remainder);
    }

    function refund(uint256 id) external nonReentrant {
        Session storage s = sessions[id];
        if (s.closed || s.payer == address(0)) revert InvalidSession();
        if (msg.sender != s.payer) revert Unauthorized();
        if (block.timestamp < s.refundAfter) revert Deadline();
        s.closed = true;
        _pay(s.payer, s.deposit);
        emit Refunded(id, s.deposit);
    }

    /// @notice A reverting recipient cannot block the other party's settlement.
    function _pay(address recipient, uint256 amount) private {
        if (amount == 0) return;
        (bool success,) = payable(recipient).call{value: amount, gas: 30_000}("");
        if (!success) {
            pendingWithdrawals[recipient] += amount;
            emit WithdrawalDeferred(recipient, amount);
        }
    }

    function withdraw(address payable recipient) external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0 || recipient == address(0)) revert InvalidSession();
        pendingWithdrawals[msg.sender] = 0;
        (bool success,) = recipient.call{value: amount}("");
        if (!success) revert TransferFailed();
    }
}
